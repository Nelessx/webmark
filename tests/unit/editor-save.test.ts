import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { initialFields } from '@/lib/editor/presentation';
import { sameFields, type CreateRequest, type EditorFields } from '@/lib/editor/protocol';
import { createNote, editedFields, toDraft, updateEditedFields } from '@/lib/editor/save';
import { getNote, saveNote } from '@/lib/storage';
import { NOTE_SCHEMA_VERSION, type ElementAnchor, type Note } from '@/lib/types';

/*
 * What the note editor (isolated frame and in-page fallback alike) saves: new
 * notes start open with the priority chosen; an edit writes only the fields
 * the user changed, status and priority included.
 */

const page = { pageKey: 'https://example.com/page', url: 'https://example.com/page', title: 'Example' };

function stored(extra: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    schemaVersion: NOTE_SCHEMA_VERSION,
    pageKey: page.pageKey,
    url: page.url,
    pageTitle: page.title,
    label: 'Revenue card',
    body: 'Show the currency',
    status: 'open',
    priority: 'medium',
    tags: ['data'],
    author: '',
    anchor: { selector: '#revenue' } as ElementAnchor,
    hasScreenshot: false,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe('initial fields', () => {
  it('a new note starts open, with medium priority', () => {
    expect(initialFields('Revenue card', undefined)).toEqual({
      label: 'Revenue card',
      body: '',
      tags: '',
      status: 'open',
      priority: 'medium',
    });
  });

  it("an existing note starts from its own status and priority", () => {
    expect(initialFields('Revenue card', stored({ status: 'in_progress', priority: 'high' }))).toMatchObject({
      status: 'in_progress',
      priority: 'high',
    });
  });
});

describe('edited fields', () => {
  const initial: EditorFields = { label: 'L', body: 'B', tags: 'a', status: 'open', priority: 'medium' };

  it('include a changed status or priority, and nothing unchanged', () => {
    expect(editedFields({ ...initial, priority: 'high' }, initial)).toEqual(['priority']);
    expect(editedFields({ ...initial, status: 'archived', body: 'B2' }, initial)).toEqual(['body', 'status']);
    expect(editedFields(initial, initial)).toEqual([]);
    expect(sameFields({ ...initial, priority: 'low' }, initial)).toBe(false);
    expect(sameFields({ ...initial }, initial)).toBe(true);
  });

  it('carry status and priority into the draft', () => {
    expect(toDraft({ ...initial, tags: 'x, y', status: 'completed', priority: 'low' }, 'Fallback')).toEqual({
      label: 'L',
      body: 'B',
      tags: ['x', 'y'],
      status: 'completed',
      priority: 'low',
    });
  });
});

describe('saving', () => {
  it('a new note is open, with the chosen priority', async () => {
    const request: CreateRequest = { mode: 'create', page, label: 'Revenue card', anchor: { selector: '#revenue' } as ElementAnchor };
    // Whatever the status field held: a new note starts open.
    const note = await createNote(request, { label: 'Revenue card', body: 'Hi', tags: [], status: 'completed', priority: 'high' }, 'Dana');
    expect(note).toMatchObject({ status: 'open', priority: 'high', author: 'Dana', schemaVersion: NOTE_SCHEMA_VERSION });
    expect(await getNote(page.pageKey, note.id)).toMatchObject({ status: 'open', priority: 'high' });
  });

  it('an edit writes only the edited fields: a status or priority changed elsewhere survives', async () => {
    await saveNote(stored());
    // Elsewhere, meanwhile.
    await saveNote(stored({ status: 'completed', priority: 'low', body: 'Changed elsewhere' }));

    const draft = { label: 'Revenue card', body: 'Show the currency', tags: ['data'], status: 'open' as const, priority: 'high' as const };
    const saved = await updateEditedFields(page.pageKey, 'n1', draft, ['priority']);
    expect(saved).toMatchObject({ status: 'completed', priority: 'high', body: 'Changed elsewhere' });

    const archived = await updateEditedFields(page.pageKey, 'n1', { ...draft, status: 'archived' }, ['status']);
    expect(archived).toMatchObject({ status: 'archived', priority: 'high', body: 'Changed elsewhere' });
  });
});
