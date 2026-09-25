import { isArchivedStatus, isNoteStatus, NOTE_PRIORITIES, NOTE_STATUSES, priorityRank } from '@/lib/noteMeta';
import type { Note, NotePriority, NoteStatus } from '@/lib/types';

/**
 * 'all' is every status except archived: archived notes are put away, and
 * only listed when 'archived' is chosen.
 */
export type StatusFilter = 'all' | NoteStatus;

export type PriorityFilter = 'all' | NotePriority;

export const STATUS_FILTERS: readonly StatusFilter[] = ['all', ...NOTE_STATUSES];

export const PRIORITY_FILTERS: readonly PriorityFilter[] = ['all', ...NOTE_PRIORITIES];

/**
 * Case-insensitive search over label, body, tags, author, page title and URL.
 * Every whitespace-separated term must match somewhere.
 */
export function noteMatchesQuery(note: Note, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = [note.label, note.body, note.author, note.pageTitle, note.url, ...note.tags.map((t) => `#${t}`)]
    .join('\n')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** True when the note carries every tag in `tags` (an empty list matches all). */
export function noteHasTags(note: Note, tags: readonly string[]): boolean {
  return tags.every((tag) => note.tags.includes(tag));
}

export function noteMatchesStatus(note: Note, status: StatusFilter): boolean {
  return status === 'all' ? !isArchivedStatus(note.status) : note.status === status;
}

export function noteMatchesPriority(note: Note, priority: PriorityFilter): boolean {
  return priority === 'all' || note.priority === priority;
}

/** Notes per status; `all` counts what "All" shows (every status but archived). */
export type StatusCounts = Record<StatusFilter, number>;

export function countByStatus(notes: readonly Note[]): StatusCounts {
  const counts = Object.fromEntries(STATUS_FILTERS.map((status) => [status, 0])) as StatusCounts;
  for (const note of notes) {
    if (isNoteStatus(note.status)) counts[note.status]++;
    if (noteMatchesStatus(note, 'all')) counts.all++;
  }
  return counts;
}

/** Notes per priority; `all` counts every note given. */
export type PriorityCounts = Record<PriorityFilter, number>;

export function countByPriority(notes: readonly Note[]): PriorityCounts {
  const counts = Object.fromEntries(PRIORITY_FILTERS.map((priority) => [priority, 0])) as PriorityCounts;
  for (const note of notes) {
    if (Object.hasOwn(counts, note.priority)) counts[note.priority]++;
    counts.all++;
  }
  return counts;
}

export interface NoteFilters {
  query: string;
  tags: readonly string[];
  status: StatusFilter;
  priority: PriorityFilter;
}

export const NO_FILTERS: NoteFilters = { query: '', tags: [], status: 'all', priority: 'all' };

/** True when anything narrows the list beyond the default view (which leaves archived notes out). */
export function filtersActive(filters: NoteFilters): boolean {
  return filters.query.trim() !== '' || filters.tags.length > 0 || filters.status !== 'all' || filters.priority !== 'all';
}

export interface FilteredNotes {
  /** Notes that pass every filter, in the order given. */
  visible: Note[];
  /** Per status, the notes that pass the other filters (search, tags, priority). */
  statusCounts: StatusCounts;
  /** Per priority, the notes that pass the other filters (search, tags, status). */
  priorityCounts: PriorityCounts;
}

/**
 * Search, tag, status and priority filters together. Each filter's counts
 * take the other filters into account, so a count is what choosing that
 * option would show.
 */
export function filterNotes(notes: readonly Note[], filters: NoteFilters): FilteredNotes {
  const searched = notes.filter((n) => noteMatchesQuery(n, filters.query) && noteHasTags(n, filters.tags));
  return {
    visible: searched.filter((n) => noteMatchesStatus(n, filters.status) && noteMatchesPriority(n, filters.priority)),
    statusCounts: countByStatus(searched.filter((n) => noteMatchesPriority(n, filters.priority))),
    priorityCounts: countByPriority(searched.filter((n) => noteMatchesStatus(n, filters.status))),
  };
}

/** Order of the notes of one page: by pin number, most urgent first (then by pin), or newest first. */
export type NoteSort = 'pin' | 'priority' | 'newest';

export const NOTE_SORTS: readonly NoteSort[] = ['pin', 'priority', 'newest'];

export const SORT_LABELS: Readonly<Record<NoteSort, string>> = {
  pin: 'Pin order',
  priority: 'Priority',
  newest: 'Newest first',
};

export function isNoteSort(value: unknown): value is NoteSort {
  return typeof value === 'string' && (NOTE_SORTS as readonly string[]).includes(value);
}

/** Pin numbers follow creation order (see pinNumber() in constants.ts). */
function byPin(a: Note, b: Note): number {
  return a.createdAt - b.createdAt;
}

/** A sorted copy; ties keep the order given. */
export function sortNotes(notes: readonly Note[], sort: NoteSort): Note[] {
  switch (sort) {
    case 'priority':
      return [...notes].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || byPin(a, b));
    case 'newest':
      return [...notes].sort((a, b) => b.createdAt - a.createdAt);
    case 'pin':
      return [...notes].sort(byPin);
  }
}

export interface TagCount {
  tag: string;
  count: number;
}

/** Distinct tags with how many notes use them, most used first. */
export function collectTags(notes: readonly Note[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const note of notes) for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** First non-empty line of a note body, for one-line previews. */
export function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? '';
}
