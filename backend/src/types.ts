/** Shared API/domain types (mirrored by clients). */

export type ItemType = 'task' | 'idea' | 'reminder';
export type ItemSource = 'voice' | 'typed' | 'import';
export type ItemStatus =
  | 'captured'
  | 'processing'
  | 'active'
  | 'scheduled'
  | 'done'
  | 'dismissed';

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

export interface TimeIntent {
  /** Resolved fire/target time in epoch ms, when a concrete time was expressed. */
  at?: number;
  /** The raw phrase that expressed time ("Friday at 3"). */
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

/** Offline-first sync operation (build plan §2.2). Idempotent via opId. */
export interface SyncOp {
  opId: string;
  /** Client wall-clock ms at the moment of the user action. */
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
  data: unknown;
  ts: number;
}

export const CONSENT_CATEGORIES = [
  'voice_processing',
  'voice_retention',
  'calendar_access',
  'chat_import',
  'analytics',
] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];
