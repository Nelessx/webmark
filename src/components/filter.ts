import type { Note, NoteStatus } from '@/lib/types';

export type StatusFilter = 'all' | NoteStatus;

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
  return status === 'all' || note.status === status;
}

export interface StatusCounts {
  all: number;
  open: number;
  resolved: number;
}

export function countByStatus(notes: readonly Note[]): StatusCounts {
  let open = 0;
  for (const note of notes) if (note.status === 'open') open++;
  return { all: notes.length, open, resolved: notes.length - open };
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
