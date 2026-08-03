/**
 * AI orchestration capability contracts (build plan §5.6).
 *
 * Every model interaction in the system goes through one of these versioned
 * input/output contracts. Nothing outside src/ai/ may call a model provider.
 */
import type { ItemType, TimeIntent } from '../types.js';

export const CONTRACT_VERSIONS = {
  classify: 'classify.v1',
  decompose: 'decompose.v1',
  confirm: 'confirm.v1',
  matchDone: 'matchDone.v1',
  schedule: 'schedule.v1',
  deriveProfile: 'deriveProfile.v1',
} as const;

export interface ClassifyInput {
  /** Present at real call sites; used only in code (learned provider) — never sent to Claude. */
  userId?: string;
  text: string;
  context: {
    /** Local hour-of-day at capture (0-23). */
    localHour: number;
    /** Types of the user's most recent items, newest first. */
    recentTypes: ItemType[];
    timezone: string;
  };
  profile?: ProfileAttributes | null;
}
export interface ClassifyOutput {
  type: ItemType;
  confidence: number;
  timeIntent: TimeIntent | null;
  /** e.g. 'computer-action' when the task implies being at a computer (Phase 3). */
  contextTag: string | null;
  /** Named desktop app the item should surface with ("when I open Photoshop…"). */
  appTrigger: string | null;
  /** Cleaned short title derived from the transcript. */
  title: string;
}

export interface DecomposeInput {
  text: string;
  type: ItemType;
  profile?: ProfileAttributes | null;
}
export interface DecomposeOutput {
  /** 0..N ordered sub-tasks; empty when the item is too small to split. */
  subtasks: string[];
}

export interface ConfirmInput {
  event:
    | 'captured'
    | 'scheduled'
    | 'moved'
    | 'conflict'
    | 'reminder_set'
    | 'completed';
  itemTitle: string;
  itemType: ItemType;
  detail: {
    subtaskCount?: number;
    when?: string;
    rationale?: string;
    conflictWith?: string;
  };
  profile?: ProfileAttributes | null;
}
export interface ConfirmOutput {
  message: string;
}

export interface MatchDoneInput {
  /** Present at real call sites; used only in code (learned provider) — never sent to Claude. */
  userId?: string;
  utterance: string;
  openItems: Array<{ id: string; title: string }>;
}
export interface MatchDoneOutput {
  matchedId: string | null;
  /** When ambiguous, candidate ids for a disambiguation prompt. */
  candidates: string[];
}

export interface ScheduleInput {
  itemTitle: string;
  itemType: ItemType;
  timeIntent: TimeIntent | null;
  /** Free slots computed by the availability model, epoch ms. */
  freeSlots: Array<{ start: number; end: number }>;
  preferences: {
    workingHours: { start: number; end: number; days: number[] };
    timezone: string;
  };
  profile?: ProfileAttributes | null;
}
export interface ScheduleOutput {
  start: number;
  end: number;
  rationale: string;
}

/** Structured, human-readable profile — never raw chat text (build plan §3, §9). */
export interface ProfileAttributes {
  tone?: 'brief' | 'neutral' | 'warm';
  verbosity?: 'low' | 'medium' | 'high';
  decompositionGranularity?: 'coarse' | 'medium' | 'fine';
  schedulingRhythm?: { creativeHours?: number[]; adminHours?: number[] };
  vocabulary?: string[];
}

export interface DeriveProfileInput {
  /** Parsed conversation turns (user side only), already stripped of metadata. */
  userMessages: string[];
  behavioralSignals?: {
    correctionRate?: number;
    avgSubtaskEdits?: number;
    completionHours?: number[];
  };
}
export interface DeriveProfileOutput {
  attributes: ProfileAttributes;
}

export interface CapabilityMap {
  classify: { in: ClassifyInput; out: ClassifyOutput };
  decompose: { in: DecomposeInput; out: DecomposeOutput };
  confirm: { in: ConfirmInput; out: ConfirmOutput };
  matchDone: { in: MatchDoneInput; out: MatchDoneOutput };
  schedule: { in: ScheduleInput; out: ScheduleOutput };
  deriveProfile: { in: DeriveProfileInput; out: DeriveProfileOutput };
}
export type Capability = keyof CapabilityMap;
