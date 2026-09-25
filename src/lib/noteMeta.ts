import type { NotePriority, NoteStatus } from './types';

/*
 * Status and priority vocabulary shared by every part of WebMark: storage,
 * validation, exports and all UI. Keep labels here so the page, popup, side
 * panel, All notes page and reports always say the same thing.
 */

/** Workflow order: what the status filters and menus list. */
export const NOTE_STATUSES: readonly NoteStatus[] = ['open', 'in_progress', 'completed', 'archived'];

/** Most urgent first: what the priority filters and menus list. */
export const NOTE_PRIORITIES: readonly NotePriority[] = ['high', 'medium', 'low'];

export const STATUS_LABELS: Readonly<Record<NoteStatus, string>> = {
  open: 'Open',
  in_progress: 'In progress',
  completed: 'Completed',
  archived: 'Archived',
};

export const PRIORITY_LABELS: Readonly<Record<NotePriority, string>> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** New notes, and notes saved before priorities existed. */
export const DEFAULT_PRIORITY: NotePriority = 'medium';

export function isNoteStatus(value: unknown): value is NoteStatus {
  return typeof value === 'string' && (NOTE_STATUSES as readonly string[]).includes(value);
}

export function isNotePriority(value: unknown): value is NotePriority {
  return typeof value === 'string' && (NOTE_PRIORITIES as readonly string[]).includes(value);
}

/**
 * A stored or imported status in today's vocabulary: notes saved before four
 * statuses existed were 'open' or 'resolved' ('resolved' is now 'completed').
 * Undefined for anything else.
 */
export function normalizeStatus(value: unknown): NoteStatus | undefined {
  if (value === 'resolved') return 'completed';
  return isNoteStatus(value) ? value : undefined;
}

/** Still needs work (open or in progress): what the toolbar badge counts. */
export function isActiveStatus(status: NoteStatus): boolean {
  return status === 'open' || status === 'in_progress';
}

/** Archived notes are put away: no pin on the page, and not part of "All". */
export function isArchivedStatus(status: NoteStatus): boolean {
  return status === 'archived';
}

/** For sorting: high first. */
export function priorityRank(priority: NotePriority): number {
  return NOTE_PRIORITIES.indexOf(priority);
}
