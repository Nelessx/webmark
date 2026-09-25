import { describe, expect, it } from 'vitest';
import {
  countByPriority,
  countByStatus,
  filterNotes,
  filtersActive,
  NO_FILTERS,
  noteMatchesPriority,
  noteMatchesStatus,
  sortNotes,
  type NoteFilters,
} from '@/components/filter';
import type { Note, NotePriority, NoteStatus } from '@/lib/types';

/*
 * The side panel's and All notes page's filters: "All" leaves archived notes
 * out (they are put away), each filter's counts take the other filters into
 * account, and notes sort by pin, priority or age.
 */

function note(id: string, status: NoteStatus, priority: NotePriority, extra: Partial<Note> = {}): Note {
  return {
    id,
    status,
    priority,
    label: `Label ${id}`,
    body: `Body ${id}`,
    tags: [],
    author: '',
    pageTitle: '',
    url: 'https://example.com/',
    createdAt: Number(id.replace(/\D/g, '')) || 0,
    ...extra,
  } as Note;
}

const notes = [
  note('n1', 'open', 'high', { tags: ['bug'] }),
  note('n2', 'open', 'medium'),
  note('n3', 'in_progress', 'high', { body: 'Checkout button is cut off', tags: ['bug'] }),
  note('n4', 'completed', 'low'),
  note('n5', 'archived', 'high', { tags: ['bug'] }),
  note('n6', 'archived', 'medium'),
];

const ids = (list: Note[]) => list.map((n) => n.id);
const filters = (partial: Partial<NoteFilters>): NoteFilters => ({ ...NO_FILTERS, ...partial });

describe('status filter', () => {
  it('"All" is every status but archived; each status matches only itself', () => {
    expect(ids(notes.filter((n) => noteMatchesStatus(n, 'all')))).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(ids(notes.filter((n) => noteMatchesStatus(n, 'open')))).toEqual(['n1', 'n2']);
    expect(ids(notes.filter((n) => noteMatchesStatus(n, 'in_progress')))).toEqual(['n3']);
    expect(ids(notes.filter((n) => noteMatchesStatus(n, 'completed')))).toEqual(['n4']);
    expect(ids(notes.filter((n) => noteMatchesStatus(n, 'archived')))).toEqual(['n5', 'n6']);
  });

  it('counts each status, and under "all" only what "All" shows', () => {
    expect(countByStatus(notes)).toEqual({ all: 4, open: 2, in_progress: 1, completed: 1, archived: 2 });
    expect(countByStatus([])).toEqual({ all: 0, open: 0, in_progress: 0, completed: 0, archived: 0 });
  });
});

describe('priority filter', () => {
  it('matches one priority, or any', () => {
    expect(ids(notes.filter((n) => noteMatchesPriority(n, 'high')))).toEqual(['n1', 'n3', 'n5']);
    expect(ids(notes.filter((n) => noteMatchesPriority(n, 'low')))).toEqual(['n4']);
    expect(notes.filter((n) => noteMatchesPriority(n, 'all'))).toHaveLength(notes.length);
  });

  it('counts each priority, and every note under "all"', () => {
    expect(countByPriority(notes)).toEqual({ all: 6, high: 3, medium: 2, low: 1 });
  });
});

describe('filterNotes', () => {
  it('shows every note but archived ones by default', () => {
    const result = filterNotes(notes, NO_FILTERS);
    expect(ids(result.visible)).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(result.statusCounts).toEqual({ all: 4, open: 2, in_progress: 1, completed: 1, archived: 2 });
    // Priority counts cover what the status filter lets through: archived notes aren't in "All".
    expect(result.priorityCounts).toEqual({ all: 4, high: 2, medium: 1, low: 1 });
  });

  it('lists archived notes under Archived only', () => {
    const result = filterNotes(notes, filters({ status: 'archived' }));
    expect(ids(result.visible)).toEqual(['n5', 'n6']);
    expect(result.priorityCounts).toEqual({ all: 2, high: 1, medium: 1, low: 0 });
  });

  it('combines status, priority, tags and search; each count is what choosing it would show', () => {
    const high = filterNotes(notes, filters({ priority: 'high' }));
    expect(ids(high.visible)).toEqual(['n1', 'n3']);
    expect(high.statusCounts).toEqual({ all: 2, open: 1, in_progress: 1, completed: 0, archived: 1 });
    expect(high.priorityCounts).toEqual({ all: 4, high: 2, medium: 1, low: 1 });

    const bugs = filterNotes(notes, filters({ tags: ['bug'], status: 'open' }));
    expect(ids(bugs.visible)).toEqual(['n1']);
    expect(bugs.statusCounts).toEqual({ all: 2, open: 1, in_progress: 1, completed: 0, archived: 1 });
    expect(bugs.priorityCounts).toEqual({ all: 1, high: 1, medium: 0, low: 0 });

    const searched = filterNotes(notes, filters({ query: 'checkout', priority: 'high' }));
    expect(ids(searched.visible)).toEqual(['n3']);
    expect(searched.statusCounts.in_progress).toBe(1);
    expect(filterNotes(notes, filters({ query: 'checkout', priority: 'low' })).visible).toEqual([]);
  });

  it('knows when anything narrows the default view', () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive(filters({ query: '   ' }))).toBe(false);
    expect(filtersActive(filters({ query: 'x' }))).toBe(true);
    expect(filtersActive(filters({ tags: ['bug'] }))).toBe(true);
    expect(filtersActive(filters({ status: 'archived' }))).toBe(true);
    expect(filtersActive(filters({ priority: 'low' }))).toBe(true);
  });
});

describe('sortNotes', () => {
  const page = [note('n1', 'open', 'low'), note('n2', 'open', 'high'), note('n3', 'completed', 'medium'), note('n4', 'open', 'high')];

  it('pin order is creation order', () => {
    expect(ids(sortNotes([...page].reverse(), 'pin'))).toEqual(['n1', 'n2', 'n3', 'n4']);
  });

  it('priority puts high first, ties in pin order', () => {
    expect(ids(sortNotes(page, 'priority'))).toEqual(['n2', 'n4', 'n3', 'n1']);
  });

  it('newest puts the latest note first', () => {
    expect(ids(sortNotes(page, 'newest'))).toEqual(['n4', 'n3', 'n2', 'n1']);
  });

  it('returns a copy', () => {
    const input = [...page];
    sortNotes(input, 'newest');
    expect(ids(input)).toEqual(['n1', 'n2', 'n3', 'n4']);
  });
});
