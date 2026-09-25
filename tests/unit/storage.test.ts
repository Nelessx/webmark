import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  bulkPutNotes,
  createNoteId,
  deleteAllNotes,
  deleteNote,
  deleteNotes,
  getAllNotes,
  getNote,
  getNotesForPage,
  getPageKeys,
  getScreenshot,
  getScreenshots,
  getSettings,
  onNotesChanged,
  onSettingsChanged,
  saveNote,
  saveScreenshot,
  saveSettings,
  setPendingFocus,
  takePendingFocus,
  updateNote,
  updateNotes,
  type NotesChange,
} from '@/lib/storage';
import { DEFAULT_SETTINGS, NOTE_SCHEMA_VERSION, type Note } from '@/lib/types';

const PAGE_A = 'https://example.com/dashboard';
const PAGE_B = 'https://example.com/settings';
const PAGE_C = 'http://localhost:3000/';

let seq = 0;

function makeNote(overrides: Partial<Note> = {}): Note {
  seq++;
  return {
    id: `note-${seq}`,
    schemaVersion: NOTE_SCHEMA_VERSION,
    pageKey: PAGE_A,
    url: PAGE_A,
    pageTitle: 'Dashboard',
    label: 'Dashboard → Revenue Card',
    body: `Note ${seq}`,
    status: 'open',
    tags: [],
    author: '',
    anchor: {
      selector: '#revenue',
      xpath: '/html/body/div[1]',
      tagName: 'div',
      classes: [],
      attributes: {},
      text: 'Revenue',
      rect: { x: 0, y: 0, width: 100, height: 50 },
      viewport: { width: 1280, height: 800 },
      ancestorTags: ['body'],
      nthOfType: 1,
    },
    hasScreenshot: false,
    createdAt: 1_000 + seq,
    updatedAt: 1_000 + seq,
    ...overrides,
  };
}

/** Let the fake storage's async onChanged listeners run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  fakeBrowser.reset();
  // A fresh, empty IndexedDB (screenshots) for every test.
  globalThis.indexedDB = new IDBFactory();
});

/** Every storage.local key, e.g. to check that no screenshot is kept there. */
const storedKeys = async () => Object.keys(await fakeBrowser.storage.local.get(null));

/** Which note pages each storage.onChanged event carried, one entry per event. */
function recordNotePageEvents(): string[][] {
  const events: string[][] = [];
  fakeBrowser.storage.onChanged.addListener((changes) => {
    const pages = Object.keys(changes).filter((key) => key.startsWith('wm:notes:'));
    if (pages.length) events.push(pages.map((key) => key.slice('wm:notes:'.length)).sort());
  });
  return events;
}

describe('notes per page', () => {
  it('returns a page\'s notes oldest first regardless of save order', async () => {
    await saveNote(makeNote({ id: 'c', createdAt: 300 }));
    await saveNote(makeNote({ id: 'a', createdAt: 100 }));
    await saveNote(makeNote({ id: 'b', createdAt: 200 }));

    expect((await getNotesForPage(PAGE_A)).map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty list for a page without notes', async () => {
    expect(await getNotesForPage(PAGE_B)).toEqual([]);
  });

  it('replaces a note with the same id instead of duplicating it', async () => {
    const note = makeNote({ id: 'x' });
    await saveNote(note);
    await saveNote({ ...note, body: 'Edited' });

    const notes = await getNotesForPage(PAGE_A);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toBe('Edited');
  });

  it('registers the page in the page index once', async () => {
    await saveNote(makeNote());
    await saveNote(makeNote());
    await saveNote(makeNote({ pageKey: PAGE_B }));

    expect(await getPageKeys()).toEqual([PAGE_A, PAGE_B]);
  });

  it('finds a single note by page and id', async () => {
    await saveNote(makeNote({ id: 'x', body: 'Hello' }));
    expect((await getNote(PAGE_A, 'x'))?.body).toBe('Hello');
    expect(await getNote(PAGE_A, 'missing')).toBeUndefined();
    expect(await getNote(PAGE_B, 'x')).toBeUndefined();
  });

  it('fills in missing fields on notes stored by an older schema', async () => {
    const legacy = { ...makeNote({ id: 'old' }), schemaVersion: 0 } as Partial<Note>;
    delete legacy.tags;
    delete legacy.author;
    delete legacy.hasScreenshot;
    await fakeBrowser.storage.local.set({ 'wm:pages': [PAGE_A], [`wm:notes:${PAGE_A}`]: [legacy] });

    const [note] = await getNotesForPage(PAGE_A);
    expect(note).toMatchObject({ tags: [], author: '', hasScreenshot: false, schemaVersion: NOTE_SCHEMA_VERSION });
  });

  it('creates unique ids', () => {
    const ids = new Set(Array.from({ length: 50 }, createNoteId));
    expect(ids.size).toBe(50);
  });
});

describe('updateNote', () => {
  it('applies the patch and bumps updatedAt', async () => {
    const note = makeNote({ id: 'x', createdAt: 1_000, updatedAt: 1_000 });
    await saveNote(note);
    vi.spyOn(Date, 'now').mockReturnValue(5_000);

    const updated = await updateNote(PAGE_A, 'x', { status: 'resolved', tags: ['bug'] });

    expect(updated).toMatchObject({ status: 'resolved', tags: ['bug'], updatedAt: 5_000, createdAt: 1_000 });
    expect(await getNote(PAGE_A, 'x')).toEqual(updated);
  });

  it('returns undefined for a note that no longer exists', async () => {
    expect(await updateNote(PAGE_A, 'missing', { body: 'x' })).toBeUndefined();
    expect(await getPageKeys()).toEqual([]);
  });

  // BUG (storage.ts, updateNote): NotePatch is Partial<…>, so `{ tags: undefined }`
  // type-checks, but the spread copies the undefined over the stored value and
  // the note is saved without `tags` (JSON drops it). migrate() does not repair
  // it because schemaVersion is current, so later `note.tags.join()` throws.
  // Suggested fix: drop undefined entries before spreading the patch.
  it('ignores fields that are explicitly undefined in a patch', async () => {
    await saveNote(makeNote({ id: 'x', tags: ['bug'], body: 'Original' }));
    await updateNote(PAGE_A, 'x', { tags: undefined, body: 'Edited' });

    const stored = await getNote(PAGE_A, 'x');
    expect(stored?.body).toBe('Edited');
    expect(stored?.tags).toEqual(['bug']);
  });
});

describe('deleteNote', () => {
  it('removes the note and its screenshot', async () => {
    await saveNote(makeNote({ id: 'keep' }));
    await saveNote(makeNote({ id: 'gone', hasScreenshot: true }));
    await saveScreenshot('gone', 'data:image/jpeg;base64,AAAA');

    await deleteNote(PAGE_A, 'gone');

    expect((await getNotesForPage(PAGE_A)).map((n) => n.id)).toEqual(['keep']);
    expect(await getScreenshot('gone')).toBeUndefined();
    expect(await getPageKeys()).toEqual([PAGE_A]);
  });

  it('removes the page from the index when its last note is deleted', async () => {
    await saveNote(makeNote({ id: 'only' }));
    await saveNote(makeNote({ id: 'other', pageKey: PAGE_B }));

    await deleteNote(PAGE_A, 'only');

    expect(await getPageKeys()).toEqual([PAGE_B]);
    const all = await fakeBrowser.storage.local.get(null);
    expect(Object.keys(all)).not.toContain(`wm:notes:${PAGE_A}`);
  });
});

describe('getAllNotes', () => {
  it('returns notes from every page, newest first', async () => {
    await saveNote(makeNote({ id: 'a1', pageKey: PAGE_A, createdAt: 100 }));
    await saveNote(makeNote({ id: 'b1', pageKey: PAGE_B, createdAt: 300 }));
    await saveNote(makeNote({ id: 'c1', pageKey: PAGE_C, createdAt: 200 }));
    await saveNote(makeNote({ id: 'a2', pageKey: PAGE_A, createdAt: 400 }));

    expect((await getAllNotes()).map((n) => n.id)).toEqual(['a2', 'b1', 'c1', 'a1']);
  });

  it('returns an empty list when nothing is stored', async () => {
    expect(await getAllNotes()).toEqual([]);
  });

  it('tolerates a page index entry whose notes are missing', async () => {
    await saveNote(makeNote({ id: 'a1' }));
    await fakeBrowser.storage.local.set({ 'wm:pages': [PAGE_A, PAGE_B] });
    expect((await getAllNotes()).map((n) => n.id)).toEqual(['a1']);
  });
});

describe('bulkPutNotes', () => {
  it('adds new notes, replaces older copies and skips stale ones', async () => {
    await saveNote(makeNote({ id: 'same', body: 'local', updatedAt: 500 }));
    await saveNote(makeNote({ id: 'newer-local', body: 'local', updatedAt: 900 }));

    const result = await bulkPutNotes([
      makeNote({ id: 'same', body: 'incoming', updatedAt: 500 }),
      makeNote({ id: 'newer-local', body: 'incoming', updatedAt: 800 }),
      makeNote({ id: 'fresh', pageKey: PAGE_B }),
    ]);

    expect(result).toEqual({ added: 1, updated: 0, skipped: 2 });
    expect((await getNote(PAGE_A, 'same'))?.body).toBe('local');
    expect((await getNote(PAGE_A, 'newer-local'))?.body).toBe('local');
    expect(await getPageKeys()).toEqual([PAGE_A, PAGE_B]);
  });

  it('replaces a note when the incoming copy is newer', async () => {
    await saveNote(makeNote({ id: 'x', body: 'local', updatedAt: 100 }));
    const result = await bulkPutNotes([makeNote({ id: 'x', body: 'incoming', updatedAt: 200 })]);

    expect(result).toEqual({ added: 0, updated: 1, skipped: 0 });
    expect(await getNotesForPage(PAGE_A)).toHaveLength(1);
    expect((await getNote(PAGE_A, 'x'))?.body).toBe('incoming');
  });

  it('keeps pages sorted by createdAt after merging', async () => {
    await saveNote(makeNote({ id: 'b', createdAt: 200 }));
    await bulkPutNotes([makeNote({ id: 'c', createdAt: 300 }), makeNote({ id: 'a', createdAt: 100 })]);
    expect((await getNotesForPage(PAGE_A)).map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('stores screenshots only for notes that were written', async () => {
    await saveNote(makeNote({ id: 'stale', updatedAt: 900 }));
    await bulkPutNotes(
      [makeNote({ id: 'stale', updatedAt: 100 }), makeNote({ id: 'new', hasScreenshot: true })],
      { stale: 'data:image/jpeg;base64,STALE', new: 'data:image/jpeg;base64,NEW' },
    );

    expect(await getScreenshot('new')).toBe('data:image/jpeg;base64,NEW');
    expect(await getScreenshot('stale')).toBeUndefined();
  });

  it('handles an empty import', async () => {
    expect(await bulkPutNotes([])).toEqual({ added: 0, updated: 0, skipped: 0 });
    expect(await getPageKeys()).toEqual([]);
  });
});

describe('deleteAllNotes', () => {
  it('removes notes, screenshots, the page index and pending focus but keeps settings', async () => {
    await saveSettings({ authorName: 'Alice', pinsVisible: false });
    await saveNote(makeNote({ id: 'a', hasScreenshot: true }));
    await saveNote(makeNote({ id: 'b', pageKey: PAGE_B }));
    await saveScreenshot('a', 'data:image/jpeg;base64,AAAA');
    await setPendingFocus(PAGE_A, 'a');

    await deleteAllNotes();

    const all = await fakeBrowser.storage.local.get(null);
    expect(Object.keys(all)).toEqual(['wm:settings']);
    expect(await getAllNotes()).toEqual([]);
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, authorName: 'Alice', pinsVisible: false });
  });
});

describe('settings', () => {
  it('returns defaults when nothing is stored', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('merges a patch into the stored settings', async () => {
    const afterFirst = await saveSettings({ authorName: 'Alice' });
    expect(afterFirst).toEqual({ ...DEFAULT_SETTINGS, authorName: 'Alice' });

    await saveSettings({ pinsVisible: false });
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, authorName: 'Alice', pinsVisible: false });
  });

  it('fills in settings added after they were first stored', async () => {
    await fakeBrowser.storage.local.set({ 'wm:settings': { authorName: 'Bob' } });
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, authorName: 'Bob' });
  });

  it('notifies listeners with the full settings object', async () => {
    const callback = vi.fn();
    const unsubscribe = onSettingsChanged(callback);

    await saveSettings({ pinsVisible: false });
    await flush();
    expect(callback).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, pinsVisible: false });

    unsubscribe();
    await saveSettings({ pinsVisible: true });
    await flush();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does not notify settings listeners about note changes', async () => {
    const callback = vi.fn();
    onSettingsChanged(callback);
    await saveNote(makeNote());
    await flush();
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('pending focus', () => {
  it('returns the note id once for the matching page', async () => {
    await setPendingFocus(PAGE_A, 'note-7');
    expect(await takePendingFocus(PAGE_A)).toBe('note-7');
    expect(await takePendingFocus(PAGE_A)).toBeUndefined();
  });

  it('ignores other pages and leaves the request for the right one', async () => {
    await setPendingFocus(PAGE_A, 'note-7');
    expect(await takePendingFocus(PAGE_B)).toBeUndefined();
    expect(await takePendingFocus(PAGE_A)).toBe('note-7');
  });

  it('expires after a minute', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await setPendingFocus(PAGE_A, 'note-7');
    now.mockReturnValue(1_000_000 + 59_999);
    expect(await takePendingFocus(PAGE_A)).toBe('note-7');

    now.mockReturnValue(2_000_000);
    await setPendingFocus(PAGE_A, 'note-8');
    now.mockReturnValue(2_000_000 + 60_000);
    expect(await takePendingFocus(PAGE_A)).toBeUndefined();
    // An expired request is still cleared so it can't fire later.
    now.mockReturnValue(2_000_000);
    expect(await takePendingFocus(PAGE_A)).toBeUndefined();
  });

  it('keeps only the latest request', async () => {
    await setPendingFocus(PAGE_A, 'first');
    await setPendingFocus(PAGE_B, 'second');
    expect(await takePendingFocus(PAGE_A)).toBeUndefined();
    expect(await takePendingFocus(PAGE_B)).toBe('second');
  });
});

describe('onNotesChanged', () => {
  it('reports the page and its sorted notes after a save', async () => {
    await saveNote(makeNote({ id: 'b', createdAt: 200 }));
    const changes: NotesChange[][] = [];
    onNotesChanged((c) => changes.push(c));

    await saveNote(makeNote({ id: 'a', createdAt: 100 }));
    await flush();

    expect(changes).toHaveLength(1);
    expect(changes[0]).toHaveLength(1);
    expect(changes[0]?.[0]?.pageKey).toBe(PAGE_A);
    expect(changes[0]?.[0]?.notes.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('reports an empty list when a page\'s last note is deleted', async () => {
    await saveNote(makeNote({ id: 'x' }));
    const callback = vi.fn();
    onNotesChanged(callback);

    await deleteNote(PAGE_A, 'x');
    await flush();

    expect(callback).toHaveBeenCalledWith([{ pageKey: PAGE_A, notes: [] }]);
  });

  it('reports every page touched by a bulk import in one call', async () => {
    const callback = vi.fn();
    onNotesChanged(callback);

    await bulkPutNotes([makeNote({ id: 'a' }), makeNote({ id: 'b', pageKey: PAGE_B })]);
    await flush();

    expect(callback).toHaveBeenCalledTimes(1);
    const pages = (callback.mock.calls[0]?.[0] as NotesChange[]).map((c) => c.pageKey).sort();
    expect(pages).toEqual([PAGE_A, PAGE_B].sort());
  });

  it('reports every page as empty after deleteAllNotes', async () => {
    await saveNote(makeNote({ id: 'a' }));
    await saveNote(makeNote({ id: 'b', pageKey: PAGE_B }));
    const callback = vi.fn();
    onNotesChanged(callback);

    await deleteAllNotes();
    await flush();

    expect(callback).toHaveBeenCalledTimes(1);
    const changes = callback.mock.calls[0]?.[0] as NotesChange[];
    expect(changes.map((c) => c.pageKey).sort()).toEqual([PAGE_A, PAGE_B].sort());
    expect(changes.every((c) => c.notes.length === 0)).toBe(true);
  });

  it('ignores settings, screenshots and the page index', async () => {
    const callback = vi.fn();
    onNotesChanged(callback);

    await saveSettings({ authorName: 'Alice' });
    await saveScreenshot('x', 'data:image/jpeg;base64,AAAA');
    await fakeBrowser.storage.local.set({ 'wm:pages': [] });
    await flush();

    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores other storage areas', async () => {
    const callback = vi.fn();
    onNotesChanged(callback);
    await fakeBrowser.storage.session.set({ [`wm:notes:${PAGE_A}`]: [makeNote()] });
    await flush();
    expect(callback).not.toHaveBeenCalled();
  });

  it('stops after unsubscribing', async () => {
    const callback = vi.fn();
    const unsubscribe = onNotesChanged(callback);
    unsubscribe();

    await saveNote(makeNote());
    await flush();
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('concurrent writes from one context', () => {
  it('keeps every note when many saves run at once', async () => {
    const notes = Array.from({ length: 25 }, (_, i) => makeNote({ id: `n${i}`, createdAt: i }));
    await Promise.all(notes.map((note) => saveNote(note)));

    expect((await getNotesForPage(PAGE_A)).map((n) => n.id)).toEqual(notes.map((n) => n.id));
  });

  it('keeps every page in the index when saves to different pages race', async () => {
    const pages = Array.from({ length: 10 }, (_, i) => `https://example.com/page-${i}`);
    await Promise.all(pages.map((pageKey) => saveNote(makeNote({ pageKey }))));

    expect((await getPageKeys()).sort()).toEqual([...pages].sort());
  });

  it('applies interleaved saves, updates and deletes in call order', async () => {
    await Promise.all([
      saveNote(makeNote({ id: 'a', createdAt: 1 })),
      saveNote(makeNote({ id: 'b', createdAt: 2 })),
      updateNote(PAGE_A, 'a', { body: 'edited' }),
      deleteNote(PAGE_A, 'b'),
      saveNote(makeNote({ id: 'c', createdAt: 3 })),
    ]);

    const notes = await getNotesForPage(PAGE_A);
    expect(notes.map((n) => n.id)).toEqual(['a', 'c']);
    expect(notes[0]?.body).toBe('edited');
  });

  it('keeps going after a failed write', async () => {
    const set = vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValueOnce(new Error('quota'));
    const results = await Promise.allSettled([saveNote(makeNote({ id: 'a' })), saveNote(makeNote({ id: 'b' }))]);

    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect((await getNotesForPage(PAGE_A)).map((n) => n.id)).toEqual(['b']);
    set.mockRestore();
  });
});

describe('screenshots live in IndexedDB, not storage.local', () => {
  const SHOT = 'data:image/jpeg;base64,/9j/AAAA';

  it('stores and reads a screenshot without a storage.local key or change event', async () => {
    const changes = vi.fn();
    fakeBrowser.storage.onChanged.addListener(changes);

    await saveScreenshot('n1', SHOT);

    expect(await getScreenshot('n1')).toBe(SHOT);
    expect(await storedKeys()).toEqual([]);
    expect(changes).not.toHaveBeenCalled();
  });

  it('deletes screenshots with their notes, one or many', async () => {
    await saveNote(makeNote({ id: 'a', hasScreenshot: true }));
    await saveNote(makeNote({ id: 'b', hasScreenshot: true, pageKey: PAGE_B }));
    await saveNote(makeNote({ id: 'c', hasScreenshot: true }));
    await Promise.all(['a', 'b', 'c'].map((id) => saveScreenshot(id, `${SHOT}${id}`)));

    await deleteNote(PAGE_A, 'a');
    expect(await getScreenshot('a')).toBeUndefined();
    await deleteNotes([
      { pageKey: PAGE_B, noteId: 'b' },
      { pageKey: PAGE_A, noteId: 'c' },
    ]);
    expect(await getScreenshots(['a', 'b', 'c'])).toEqual({});
  });

  it('deleteAllNotes clears every screenshot', async () => {
    await saveNote(makeNote({ id: 'a', hasScreenshot: true }));
    await saveScreenshot('a', SHOT);
    await saveScreenshot('orphan', SHOT);

    await deleteAllNotes();

    expect(await getScreenshots(['a', 'orphan'])).toEqual({});
  });

  it('reads several screenshots at once, leaving out notes without one', async () => {
    await saveScreenshot('a', `${SHOT}a`);
    await saveScreenshot('b', `${SHOT}b`);
    expect(await getScreenshots(['a', 'missing', 'b'])).toEqual({ a: `${SHOT}a`, b: `${SHOT}b` });
  });

  it('still reads a screenshot stored under the old wm:shot: key until it is migrated', async () => {
    await fakeBrowser.storage.local.set({ 'wm:shot:old': SHOT });
    expect(await getScreenshot('old')).toBe(SHOT);
    await deleteNote(PAGE_A, 'old');
    expect(await storedKeys()).toEqual([]);
  });

  it('imports screenshots into IndexedDB', async () => {
    await bulkPutNotes([makeNote({ id: 'imported', hasScreenshot: true })], { imported: SHOT });
    expect(await getScreenshot('imported')).toBe(SHOT);
    expect((await storedKeys()).filter((key) => key.startsWith('wm:shot:'))).toEqual([]);
  });
});

describe('batch writes', () => {
  it('updateNotes applies every change with one write per page and returns the notes in order', async () => {
    await saveNote(makeNote({ id: 'a1', createdAt: 1 }));
    await saveNote(makeNote({ id: 'a2', createdAt: 2 }));
    await saveNote(makeNote({ id: 'b1', pageKey: PAGE_B, createdAt: 3 }));
    const set = vi.spyOn(fakeBrowser.storage.local, 'set');
    const events = recordNotePageEvents();
    vi.spyOn(Date, 'now').mockReturnValue(9_000);

    const results = await updateNotes([
      { pageKey: PAGE_B, noteId: 'b1', patch: { status: 'resolved' } },
      { pageKey: PAGE_A, noteId: 'a1', patch: { status: 'resolved', tags: undefined } },
      { pageKey: PAGE_A, noteId: 'gone', patch: { status: 'resolved' } },
      { pageKey: PAGE_A, noteId: 'a2', patch: { body: 'edited' } },
    ]);

    expect(results.map((n) => n?.id)).toEqual(['b1', 'a1', undefined, 'a2']);
    expect(set).toHaveBeenCalledTimes(1);
    expect(events).toEqual([[PAGE_A, PAGE_B].sort()]);
    expect(await getNote(PAGE_A, 'a1')).toMatchObject({ status: 'resolved', tags: [], updatedAt: 9_000 });
    expect(await getNote(PAGE_A, 'a2')).toMatchObject({ status: 'open', body: 'edited' });
    expect((await getNote(PAGE_B, 'b1'))?.status).toBe('resolved');
  });

  it('updateNotes with nothing to change does not write', async () => {
    const set = vi.spyOn(fakeBrowser.storage.local, 'set');
    expect(await updateNotes([])).toEqual([]);
    expect(await updateNotes([{ pageKey: PAGE_A, noteId: 'missing', patch: { body: 'x' } }])).toEqual([undefined]);
    expect(set).not.toHaveBeenCalled();
  });

  it('deleteNotes removes notes across pages with one change per page and keeps the index right', async () => {
    await saveNote(makeNote({ id: 'a1' }));
    await saveNote(makeNote({ id: 'a2' }));
    await saveNote(makeNote({ id: 'a3' }));
    await saveNote(makeNote({ id: 'b1', pageKey: PAGE_B }));
    await saveNote(makeNote({ id: 'c1', pageKey: PAGE_C }));
    const events = recordNotePageEvents();

    await deleteNotes([
      { pageKey: PAGE_A, noteId: 'a1' },
      { pageKey: PAGE_B, noteId: 'b1' },
      { pageKey: PAGE_A, noteId: 'a3' },
      { pageKey: PAGE_C, noteId: 'not-there' },
    ]);

    expect(events.flat().sort()).toEqual([PAGE_A, PAGE_B].sort());
    expect((await getNotesForPage(PAGE_A)).map((n) => n.id)).toEqual(['a2']);
    expect(await getNotesForPage(PAGE_B)).toEqual([]);
    expect((await getPageKeys()).sort()).toEqual([PAGE_A, PAGE_C].sort());
    expect(await storedKeys()).not.toContain(`wm:notes:${PAGE_B}`);
  });

  it('deleteNotes with no notes does nothing', async () => {
    const remove = vi.spyOn(fakeBrowser.storage.local, 'remove');
    await deleteNotes([]);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('credentials in saved URLs', () => {
  it('redacts tokens from a note URL when it is saved', async () => {
    const saved = await saveNote(makeNote({ id: 'x', url: `${PAGE_A}?token=s3cr3t&tab=2#access_token=abc` }));
    const stored = await getNote(PAGE_A, 'x');
    expect(stored?.url).toBe(`${PAGE_A}?token=REDACTED&tab=2#access_token=REDACTED`);
    expect(saved.url).toBe(stored?.url);
  });

  it('redacts tokens from imported notes too', async () => {
    await bulkPutNotes([makeNote({ id: 'x', url: `${PAGE_A}?api_key=k1` })]);
    expect((await getNote(PAGE_A, 'x'))?.url).toBe(`${PAGE_A}?api_key=REDACTED`);
  });

  it('leaves URLs without credentials untouched', async () => {
    await saveNote(makeNote({ id: 'x', url: `${PAGE_A}?q=a%20b#section` }));
    expect((await getNote(PAGE_A, 'x'))?.url).toBe(`${PAGE_A}?q=a%20b#section`);
  });
});

describe('bulkPutNotes keeps hasScreenshot true only for stored screenshots', () => {
  it('flags notes whose screenshot came with them, and clears the flag when none is stored', async () => {
    await bulkPutNotes(
      [makeNote({ id: 'with', hasScreenshot: false }), makeNote({ id: 'without', hasScreenshot: true })],
      { with: 'data:image/jpeg;base64,AAAA' },
    );
    expect((await getNote(PAGE_A, 'with'))?.hasScreenshot).toBe(true);
    expect((await getNote(PAGE_A, 'without'))?.hasScreenshot).toBe(false);
  });

  it('keeps the flag of a newer copy when the screenshot is already stored here', async () => {
    await saveNote(makeNote({ id: 'x', hasScreenshot: true, updatedAt: 1 }));
    await saveScreenshot('x', 'data:image/jpeg;base64,AAAA');
    await bulkPutNotes([makeNote({ id: 'x', hasScreenshot: true, updatedAt: 2, body: 'newer' })]);
    expect(await getNote(PAGE_A, 'x')).toMatchObject({ body: 'newer', hasScreenshot: true });
  });

  it("does not change the caller's notes", async () => {
    const note = makeNote({ id: 'x', hasScreenshot: true });
    await bulkPutNotes([note]);
    expect(note.hasScreenshot).toBe(true);
  });

  it('does not rewrite pages whose incoming notes were all older', async () => {
    await saveNote(makeNote({ id: 'x', updatedAt: 500 }));
    const set = vi.spyOn(fakeBrowser.storage.local, 'set');
    expect(await bulkPutNotes([makeNote({ id: 'x', updatedAt: 100 })])).toEqual({ added: 0, updated: 0, skipped: 1 });
    expect(set).not.toHaveBeenCalled();
  });
});
