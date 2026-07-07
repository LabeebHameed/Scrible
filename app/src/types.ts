/** Mirrors backend/src/types.ts — the shared sync/API contract. */

export type ItemType = 'task' | 'idea' | 'reminder';
export type ItemSource = 'voice' | 'typed' | 'import';
export type ItemStatus =
  | 'captured'
  | 'processing'
  | 'active'
  | 'scheduled'
  | 'done'
  | 'dismissed';

export interface TimeIntent {
  at?: number;
  phrase?: string;
  recurrence?: string;
}

export interface Subtask {
  id: string;
  itemId: string;
  title: string;
  position: number;
  origin: 'ai' | 'user';
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Item {
  id: string;
  type: ItemType;
  source: ItemSource;
  rawText: string;
  title: string;
  confidence: number | null;
  status: ItemStatus;
  contextTag: string | null;
  timeIntent: TimeIntent | null;
  summary: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  subtasks?: Subtask[];
}

export interface SyncOp {
  opId: string;
  ts: number;
  kind:
    | 'item.create'
    | 'item.update'
    | 'item.complete'
    | 'item.reopen'
    | 'item.retype'
    | 'item.delete'
    | 'subtask.create'
    | 'subtask.update'
    | 'subtask.complete'
    | 'subtask.delete';
  entityId: string;
  data?: Record<string, unknown>;
}

export interface ChangeRow {
  seq: number;
  entityType: string;
  entityId: string;
  op: 'upsert' | 'delete';
  data: Item | null;
  ts: number;
}
