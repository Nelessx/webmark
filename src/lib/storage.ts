import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, NOTE_SCHEMA_VERSION, type Note, type NotePatch, type Settings } from './types';

/*
 * Storage layout (browser.storage.local):
 *
 *   wm:pages               string[]   page keys that have at least one note
 *   wm:notes:<pageKey>     Note[]     notes for one page, oldest first
 *   wm:shot:<noteId>       string     JPEG data URL of the element screenshot
 *   wm:settings            Settings
 *   wm:pending-focus       PendingFocus  note to focus after a page is opened from the dashboard
 *
 * Notes are grouped per page so a content script only reads its own page, and
 * screenshots live under separate keys so note lists stay small.
 */

const KEY_PAGES = 'wm:pages';
const KEY_SETTINGS = 'wm:settings';
const KEY_PENDING_FOCUS = 'wm:pending-focus';
const NOTES_PREFIX = 'wm:notes:';
const SHOT_PREFIX = 'wm:shot:';

const notesKey = (pageKey: string) => NOTES_PREFIX + pageKey;
const shotKey = (noteId: string) => SHOT_PREFIX + noteId;

const area = () => browser.storage.local;

/**
 * Serialises writes made from this JS context so read-modify-write cycles
 * don't overwrite each other (e.g. two quick edits from the same side panel).
 */
let writeQueue: Promise<unknown> = Promise.resolve();
function queued<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

function byCreatedAt(a: Note, b: Note) {
  return a.createdAt - b.createdAt;
}

/** Fill in fields added after a note was first stored. */
function migrate(note: Note): Note {
  if (note.schemaVersion === NOTE_SCHEMA_VERSION) return note;
  return {
    ...note,
    tags: note.tags ?? [],
    author: note.author ?? '',
    status: note.status ?? 'open',
    hasScreenshot: note.hasScreenshot ?? false,
    schemaVersion: NOTE_SCHEMA_VERSION,
  };
}

export function createNoteId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getPageKeys(): Promise<string[]> {
  const res = await area().get(KEY_PAGES);
  return (res[KEY_PAGES] as string[] | undefined) ?? [];
}

export async function getNotesForPage(pageKey: string): Promise<Note[]> {
  const key = notesKey(pageKey);
  const res = await area().get(key);
  return ((res[key] as Note[] | undefined) ?? []).map(migrate).sort(byCreatedAt);
}

export async function getNote(pageKey: string, noteId: string): Promise<Note | undefined> {
  return (await getNotesForPage(pageKey)).find((n) => n.id === noteId);
}

/** Every note across all pages, newest first. */
export async function getAllNotes(): Promise<Note[]> {
  const pageKeys = await getPageKeys();
  if (!pageKeys.length) return [];
  const res = await area().get(pageKeys.map(notesKey));
  return Object.values(res)
    .flatMap((list) => (list as Note[]) ?? [])
    .map(migrate)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getScreenshot(noteId: string): Promise<string | undefined> {
  const key = shotKey(noteId);
  const res = await area().get(key);
  return res[key] as string | undefined;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function writePage(pageKey: string, notes: Note[]): Promise<void> {
  const pageKeys = await getPageKeys();
  if (notes.length) {
    const update: Record<string, unknown> = { [notesKey(pageKey)]: notes.sort(byCreatedAt) };
    if (!pageKeys.includes(pageKey)) update[KEY_PAGES] = [...pageKeys, pageKey];
    await area().set(update);
  } else {
    await area().remove(notesKey(pageKey));
    if (pageKeys.includes(pageKey)) {
      await area().set({ [KEY_PAGES]: pageKeys.filter((k) => k !== pageKey) });
    }
  }
}

/** Insert or replace a note (matched by id within its page). */
export function saveNote(note: Note): Promise<Note> {
  return queued(async () => {
    const notes = await getNotesForPage(note.pageKey);
    const i = notes.findIndex((n) => n.id === note.id);
    if (i >= 0) notes[i] = note;
    else notes.push(note);
    await writePage(note.pageKey, notes);
    return note;
  });
}

/** Apply a partial change and bump updatedAt. Returns undefined if the note no longer exists. */
export function updateNote(pageKey: string, noteId: string, patch: NotePatch): Promise<Note | undefined> {
  return queued(async () => {
    const notes = await getNotesForPage(pageKey);
    const i = notes.findIndex((n) => n.id === noteId);
    const current = notes[i];
    if (!current) return undefined;
    const updated: Note = { ...current, ...patch, updatedAt: Date.now() };
    notes[i] = updated;
    await writePage(pageKey, notes);
    return updated;
  });
}

export function deleteNote(pageKey: string, noteId: string): Promise<void> {
  return queued(async () => {
    const notes = await getNotesForPage(pageKey);
    await writePage(
      pageKey,
      notes.filter((n) => n.id !== noteId),
    );
    await area().remove(shotKey(noteId));
  });
}

/**
 * Merge many notes at once (used by import). A note replaces an existing one
 * with the same id only if it is newer. Returns counts for the import summary.
 */
export function bulkPutNotes(
  incoming: Note[],
  screenshots: Record<string, string> = {},
): Promise<{ added: number; updated: number; skipped: number }> {
  return queued(async () => {
    const result = { added: 0, updated: 0, skipped: 0 };
    const byPage = new Map<string, Note[]>();
    for (const note of incoming) {
      const list = byPage.get(note.pageKey) ?? [];
      list.push(migrate(note));
      byPage.set(note.pageKey, list);
    }

    const pageKeys = await getPageKeys();
    const existingRes = await area().get([...byPage.keys()].map(notesKey));
    const update: Record<string, unknown> = {};

    for (const [pageKey, notes] of byPage) {
      const existing = ((existingRes[notesKey(pageKey)] as Note[] | undefined) ?? []).map(migrate);
      for (const note of notes) {
        const i = existing.findIndex((n) => n.id === note.id);
        const current = existing[i];
        if (!current) {
          existing.push(note);
          result.added++;
        } else if (note.updatedAt > current.updatedAt) {
          existing[i] = note;
          result.updated++;
        } else {
          result.skipped++;
          continue;
        }
        const shot = screenshots[note.id];
        if (shot) update[shotKey(note.id)] = shot;
      }
      update[notesKey(pageKey)] = existing.sort(byCreatedAt);
      if (!pageKeys.includes(pageKey)) pageKeys.push(pageKey);
    }
    update[KEY_PAGES] = pageKeys;
    await area().set(update);
    return result;
  });
}

/** Remove every note and screenshot. Settings are kept. */
export function deleteAllNotes(): Promise<void> {
  return queued(async () => {
    const all = await area().get(null);
    const keys = Object.keys(all).filter(
      (k) => k === KEY_PAGES || k.startsWith(NOTES_PREFIX) || k.startsWith(SHOT_PREFIX) || k === KEY_PENDING_FOCUS,
    );
    if (keys.length) await area().remove(keys);
  });
}

export async function saveScreenshot(noteId: string, dataUrl: string): Promise<void> {
  await area().set({ [shotKey(noteId)]: dataUrl });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(): Promise<Settings> {
  const res = await area().get(KEY_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...((res[KEY_SETTINGS] as Partial<Settings> | undefined) ?? {}) };
}

export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  return queued(async () => {
    const next = { ...(await getSettings()), ...patch };
    await area().set({ [KEY_SETTINGS]: next });
    return next;
  });
}

// ---------------------------------------------------------------------------
// Pending focus: dashboard/side panel opens a page and asks its content script
// to scroll to a note once it loads.
// ---------------------------------------------------------------------------

interface PendingFocus {
  pageKey: string;
  noteId: string;
  at: number;
}

const PENDING_FOCUS_TTL_MS = 60_000;

export async function setPendingFocus(pageKey: string, noteId: string): Promise<void> {
  const value: PendingFocus = { pageKey, noteId, at: Date.now() };
  await area().set({ [KEY_PENDING_FOCUS]: value });
}

/** Returns and clears the pending note id if it targets this page and is recent. */
export async function takePendingFocus(pageKey: string): Promise<string | undefined> {
  const res = await area().get(KEY_PENDING_FOCUS);
  const pending = res[KEY_PENDING_FOCUS] as PendingFocus | undefined;
  if (!pending || pending.pageKey !== pageKey) return undefined;
  await area().remove(KEY_PENDING_FOCUS);
  return Date.now() - pending.at < PENDING_FOCUS_TTL_MS ? pending.noteId : undefined;
}

// ---------------------------------------------------------------------------
// Change subscriptions
// ---------------------------------------------------------------------------

export interface NotesChange {
  pageKey: string;
  /** The page's notes after the change (empty if the page has none left). */
  notes: Note[];
}

/** Called whenever any page's notes change, from any extension context. */
export function onNotesChanged(callback: (changes: NotesChange[]) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
    if (areaName !== 'local') return;
    const noteChanges: NotesChange[] = Object.entries(changes)
      .filter(([key]) => key.startsWith(NOTES_PREFIX))
      .map(([key, change]) => ({
        pageKey: key.slice(NOTES_PREFIX.length),
        notes: ((change.newValue as Note[] | undefined) ?? []).map(migrate).sort(byCreatedAt),
      }));
    if (noteChanges.length) callback(noteChanges);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

export function onSettingsChanged(callback: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
    if (areaName !== 'local' || !(KEY_SETTINGS in changes)) return;
    callback({ ...DEFAULT_SETTINGS, ...((changes[KEY_SETTINGS].newValue as Partial<Settings> | undefined) ?? {}) });
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
