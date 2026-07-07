/**
 * Offline-first local store (build plan §2.2 client side).
 *
 * Every mutation is a SyncOp: applied optimistically to local state, appended to a
 * durable outbound queue, and replayed to the server when connectivity allows.
 * Server state flows back through the change feed (cursor = change seq).
 * Pure TypeScript — storage and API are injected, so this is unit-testable in Node.
 */
import type { ApiClient } from './api';
import type { ChangeRow, Item, ItemSource, ItemType, SyncOp } from './types';

export interface KV {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

interface PersistedState {
  items: Record<string, Item>;
  pendingOps: SyncOp[];
  cursor: number;
}

const newId = (): string =>
  // RFC4122-ish without importing crypto (RN has no built-in randomUUID pre-Hermes-next)
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

export class SyncStore {
  items: Record<string, Item> = {};
  pendingOps: SyncOp[] = [];
  cursor = 0;
  syncing = false;
  lastError: string | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private kv: KV,
    private api: ApiClient,
    private storageKey = 'scrible.store.v1',
  ) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  async load(): Promise<void> {
    const raw = await this.kv.getItem(this.storageKey);
    if (raw) {
      try {
        const s = JSON.parse(raw) as PersistedState;
        this.items = s.items ?? {};
        this.pendingOps = s.pendingOps ?? [];
        this.cursor = s.cursor ?? 0;
      } catch {
        /* corrupted local cache — start clean; server is the source of truth */
      }
    }
    this.notify();
  }

  private async persist(): Promise<void> {
    await this.kv.setItem(
      this.storageKey,
      JSON.stringify({ items: this.items, pendingOps: this.pendingOps, cursor: this.cursor }),
    );
  }

  /** The "right now" queue: explicit times first (soonest), then oldest-first. */
  queue(limit = 5): Item[] {
    const open = Object.values(this.items).filter((i) =>
      ['captured', 'processing', 'active', 'scheduled'].includes(i.status),
    );
    const timed = open
      .filter((i) => i.timeIntent?.at)
      .sort((a, b) => (a.timeIntent!.at ?? 0) - (b.timeIntent!.at ?? 0));
    const rest = open.filter((i) => !i.timeIntent?.at).sort((a, b) => a.createdAt - b.createdAt);
    return [...timed, ...rest].slice(0, limit);
  }

  allOpen(): Item[] {
    return Object.values(this.items)
      .filter((i) => i.status !== 'dismissed' && i.status !== 'done')
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  completed(): Item[] {
    return Object.values(this.items)
      .filter((i) => i.status === 'done')
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  }

  /** Capture — works fully offline; enrichment arrives later via the change feed. */
  async capture(rawText: string, source: ItemSource): Promise<Item> {
    const id = newId();
    const now = Date.now();
    const item: Item = {
      id,
      type: 'task',
      source,
      rawText,
      title: rawText.length > 80 ? `${rawText.slice(0, 77)}…` : rawText,
      confidence: null,
      status: 'captured',
      contextTag: null,
      timeIntent: null,
      summary: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      subtasks: [],
    };
    this.items[id] = item;
    await this.enqueue({ opId: newId(), ts: now, kind: 'item.create', entityId: id, data: { rawText, source } });
    return item;
  }

  async complete(id: string): Promise<void> {
    const item = this.items[id];
    if (!item) return;
    item.status = 'done';
    item.completedAt = Date.now();
    await this.enqueue({ opId: newId(), ts: Date.now(), kind: 'item.complete', entityId: id });
  }

  async reopen(id: string): Promise<void> {
    const item = this.items[id];
    if (!item) return;
    item.status = 'active';
    item.completedAt = null;
    await this.enqueue({ opId: newId(), ts: Date.now(), kind: 'item.reopen', entityId: id });
  }

  /** One-tap classification correction — recorded server-side as a quality signal. */
  async retype(id: string, type: ItemType): Promise<void> {
    const item = this.items[id];
    if (!item) return;
    item.type = type;
    await this.enqueue({ opId: newId(), ts: Date.now(), kind: 'item.retype', entityId: id, data: { type } });
  }

  async remove(id: string): Promise<void> {
    delete this.items[id];
    await this.enqueue({ opId: newId(), ts: Date.now(), kind: 'item.delete', entityId: id });
  }

  async completeSubtask(itemId: string, subtaskId: string): Promise<void> {
    const st = this.items[itemId]?.subtasks?.find((s) => s.id === subtaskId);
    if (st) st.completedAt = Date.now();
    await this.enqueue({ opId: newId(), ts: Date.now(), kind: 'subtask.complete', entityId: subtaskId });
  }

  private async enqueue(op: SyncOp): Promise<void> {
    this.pendingOps.push(op);
    await this.persist();
    this.notify();
    void this.sync();
  }

  applyChange(change: ChangeRow): void {
    if (change.entityType !== 'item') return;
    if (change.op === 'delete') {
      delete this.items[change.entityId];
    } else if (change.data) {
      this.items[change.entityId] = change.data;
    }
    this.cursor = Math.max(this.cursor, change.seq);
  }

  /**
   * Push queued ops, then pull the change feed. Concurrent calls are serialized —
   * each caller's sync runs after any in-flight one, so no request is ever dropped.
   * Replays are idempotent server-side (opId), so a crash between push and ack
   * loses nothing.
   */
  sync(): Promise<boolean> {
    this.syncChain = this.syncChain.then(
      () => this.doSync(),
      () => this.doSync(),
    );
    return this.syncChain;
  }
  private syncChain: Promise<boolean> = Promise.resolve(true);

  private async doSync(): Promise<boolean> {
    this.syncing = true;
    try {
      if (this.pendingOps.length > 0) {
        const batch = this.pendingOps.slice(0, 200);
        await this.api.pushOps(batch);
        this.pendingOps = this.pendingOps.filter((op) => !batch.some((b) => b.opId === op.opId));
      }
      const { changes } = await this.api.changesSince(this.cursor);
      for (const change of changes) this.applyChange(change);
      this.lastError = null;
      await this.persist();
      this.notify();
      return true;
    } catch (err) {
      // Offline or server unreachable — queue stays durable, nothing is lost.
      this.lastError = err instanceof Error ? err.message : 'sync failed';
      this.notify();
      return false;
    } finally {
      this.syncing = false;
    }
  }
}
