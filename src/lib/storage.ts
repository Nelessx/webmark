import { browser, type Browser, type PublicPath } from 'wxt/browser';
import { listen } from './messages';
import { DEFAULT_PRIORITY, isNotePriority, normalizeStatus } from './noteMeta';
import * as shotDb from './screenshotDb';
import { checkStorageRequest, isStorageRequest, STORAGE_REQUEST, type StorageRequest } from './storageRequests';
import { DEFAULT_SETTINGS, NOTE_SCHEMA_VERSION, type Note, type NotePatch, type Settings } from './types';
import { redactUrl, sanitizePageKey } from './url';

/*
 * Storage layout (browser.storage.local):
 *
 *   wm:pages               string[]      page keys that have at least one note
 *   wm:notes:<pageKey>     Note[]        notes for one page, oldest first
 *   wm:settings            Settings
 *   wm:pending-focus       PendingFocus  note to focus after a page is opened from the dashboard
 *   wm:storage-version     number        layout the background last migrated to (see migrateStorage)
 *
 * Screenshots (JPEG data URLs) live in IndexedDB in the extension's origin,
 * keyed by note id (screenshotDb.ts), so saving or deleting one isn't pushed
 * to every tab through storage.onChanged. Before layout version 2 they were
 * kept here as `wm:shot:<noteId>`; the background moves them over on startup,
 * and keeps using that layout if IndexedDB is unavailable.
 *
 * Notes are grouped per page so a content script only reads its own page.
 *
 * Single writer: every context reads storage directly, but all writes run in
 * the background, one at a time. Content scripts and extension pages (popup,
 * side panel, dashboard, editor frame) send theirs there as `wm:storage`
 * messages, so read-modify-write cycles from two contexts can never
 * interleave and drop a note, or a page from the index.
 */

const KEY_PAGES = 'wm:pages';
const KEY_SETTINGS = 'wm:settings';
const KEY_PENDING_FOCUS = 'wm:pending-focus';
const KEY_STORAGE_VERSION = 'wm:storage-version';
const NOTES_PREFIX = 'wm:notes:';
const LEGACY_SHOT_PREFIX = 'wm:shot:';

/** 2: screenshots in IndexedDB; credentials removed from page keys and saved URLs. */
const STORAGE_VERSION = 2;
/** Layout marker while screenshots sit in storage.local (IndexedDB unavailable), so a later start moves them. */
const LEGACY_SHOTS_VERSION = 1;

const notesKey = (pageKey: string) => NOTES_PREFIX + pageKey;
const legacyShotKey = (noteId: string) => LEGACY_SHOT_PREFIX + noteId;

const area = () => browser.storage.local;

export interface NoteRef {
  pageKey: string;
  noteId: string;
}

export interface NoteUpdate extends NoteRef {
  patch: NotePatch;
}

export interface ImportCounts {
  added: number;
  updated: number;
  skipped: number;
}

/**
 * Serialises the writes made through this JS context, so read-modify-write
 * cycles don't overwrite each other and calls apply in call order. In the
 * background this is the one queue every context's writes pass through.
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
    // Schema 1 had 'open' | 'resolved' and no priority.
    status: normalizeStatus(note.status) ?? 'open',
    priority: isNotePriority(note.priority) ? note.priority : DEFAULT_PRIORITY,
    hasScreenshot: note.hasScreenshot ?? false,
    schemaVersion: NOTE_SCHEMA_VERSION,
  };
}

export function createNoteId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Reads (any context)
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

export async function getSettings(): Promise<Settings> {
  const res = await area().get(KEY_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...((res[KEY_SETTINGS] as Partial<Settings> | undefined) ?? {}) };
}

/** Several pages' notes in one read, oldest first; missing pages come back empty. */
async function readPages(pageKeys: Iterable<string>): Promise<Map<string, Note[]>> {
  const keys = [...new Set(pageKeys)];
  const res = keys.length ? await area().get(keys.map(notesKey)) : {};
  return new Map(keys.map((key) => [key, ((res[notesKey(key)] as Note[] | undefined) ?? []).map(migrate).sort(byCreatedAt)]));
}

/** All storage.local keys, without loading values where the browser allows it (Chrome 130+). */
async function storedKeys(): Promise<string[]> {
  try {
    const getKeys = (area() as { getKeys?: () => Promise<string[]> }).getKeys;
    if (typeof getKeys === 'function') return await getKeys.call(area());
  } catch {
    // Not implemented here.
  }
  return Object.keys(await area().get(null));
}

// ---------------------------------------------------------------------------
// Screenshots, as the writer sees them: IndexedDB, or storage.local keys
// (the original layout) when IndexedDB is unavailable.
// ---------------------------------------------------------------------------

let idbAvailable: Promise<boolean> | undefined;
const useIdb = () => (idbAvailable ??= shotDb.isAvailable());

/** Until the migration has run, screenshots may still sit under wm:shot:* keys. */
let legacyShotsMayExist = true;

/** Resolves once the background's startup migration has finished (or failed). */
let migration: Promise<void> = Promise.resolve();

const legacyShots = {
  async get(noteId: string): Promise<string | undefined> {
    const key = legacyShotKey(noteId);
    return (await area().get(key))[key] as string | undefined;
  },
  async has(noteIds: readonly string[]): Promise<Set<string>> {
    if (!noteIds.length) return new Set();
    const found = await area().get(noteIds.map(legacyShotKey));
    return new Set(noteIds.filter((id) => typeof found[legacyShotKey(id)] === 'string'));
  },
  async put(entries: Readonly<Record<string, string>>): Promise<void> {
    const list = Object.entries(entries);
    if (!list.length) return;
    const update: Record<string, unknown> = { [KEY_STORAGE_VERSION]: LEGACY_SHOTS_VERSION };
    for (const [id, dataUrl] of list) update[legacyShotKey(id)] = dataUrl;
    await area().set(update);
  },
  async remove(noteIds: readonly string[]): Promise<void> {
    if (noteIds.length) await area().remove(noteIds.map(legacyShotKey));
  },
};

async function readShot(noteId: string): Promise<string | undefined> {
  if (await useIdb()) {
    const shot = await shotDb.get(noteId);
    if (shot !== undefined || !legacyShotsMayExist) return shot;
  }
  return legacyShots.get(noteId);
}

async function shotsExist(noteIds: readonly string[]): Promise<Set<string>> {
  const found = (await useIdb()) ? await shotDb.has(noteIds) : new Set<string>();
  if (!(await useIdb()) || legacyShotsMayExist) {
    for (const id of await legacyShots.has(noteIds.filter((id) => !found.has(id)))) found.add(id);
  }
  return found;
}

async function writeShots(entries: Readonly<Record<string, string>>): Promise<void> {
  if (await useIdb()) await shotDb.put(entries);
  else await legacyShots.put(entries);
}

async function removeShots(noteIds: readonly string[]): Promise<void> {
  if (await useIdb()) await shotDb.remove(noteIds);
  if (!(await useIdb()) || legacyShotsMayExist) await legacyShots.remove(noteIds);
}

// ---------------------------------------------------------------------------
// Write operations. These run only in the writer: the background, or a
// context with no background to talk to (unit tests).
// ---------------------------------------------------------------------------

/** Skip keys set to undefined so a partial patch never erases stored fields. */
function definedFields(patch: NotePatch): NotePatch {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as NotePatch;
}

/** A note as it is stored: credentials in its URL redacted (see redactUrl). */
function forStorage(note: Note): Note {
  const url = redactUrl(note.url);
  return url === note.url ? note : { ...note, url };
}

interface PendingFocus {
  pageKey: string;
  noteId: string;
  at: number;
}

const PENDING_FOCUS_TTL_MS = 60_000;

const writer = {
  async saveNote(note: Note): Promise<Note> {
    const stored = forStorage(note);
    const { pageKey } = stored;
    const notes = await getNotesForPage(pageKey);
    const i = notes.findIndex((n) => n.id === stored.id);
    if (i >= 0) notes[i] = stored;
    else notes.push(stored);
    const update: Record<string, unknown> = { [notesKey(pageKey)]: notes.sort(byCreatedAt) };
    const pageKeys = await getPageKeys();
    if (!pageKeys.includes(pageKey)) update[KEY_PAGES] = [...pageKeys, pageKey];
    await area().set(update);
    return stored;
  },

  async updateNote(pageKey: string, noteId: string, patch: NotePatch): Promise<Note | undefined> {
    const [updated] = await writer.updateNotes([{ pageKey, noteId, patch }]);
    return updated;
  },

  /** One storage write for all touched pages. */
  async updateNotes(changes: NoteUpdate[]): Promise<(Note | undefined)[]> {
    const pages = await readPages(changes.map((c) => c.pageKey));
    const touched = new Set<string>();
    const now = Date.now();
    const results = changes.map(({ pageKey, noteId, patch }) => {
      const notes = pages.get(pageKey) ?? [];
      const i = notes.findIndex((n) => n.id === noteId);
      const current = notes[i];
      if (!current) return undefined;
      const updated: Note = { ...current, ...definedFields(patch), updatedAt: now };
      notes[i] = updated;
      touched.add(pageKey);
      return updated;
    });
    if (touched.size) {
      await area().set(Object.fromEntries([...touched].map((key) => [notesKey(key), pages.get(key) ?? []])));
    }
    return results;
  },

  async deleteNote(pageKey: string, noteId: string): Promise<void> {
    await writer.deleteNotes([{ pageKey, noteId }]);
  },

  /** One storage write per touched page (and the page index), then their screenshots. */
  async deleteNotes(refs: NoteRef[]): Promise<void> {
    const idsByPage = new Map<string, Set<string>>();
    for (const { pageKey, noteId } of refs) idsByPage.set(pageKey, (idsByPage.get(pageKey) ?? new Set()).add(noteId));
    const pages = await readPages(idsByPage.keys());

    const update: Record<string, unknown> = {};
    const emptied: string[] = [];
    for (const [pageKey, ids] of idsByPage) {
      const notes = pages.get(pageKey) ?? [];
      const kept = notes.filter((n) => !ids.has(n.id));
      if (kept.length === notes.length) continue;
      if (kept.length) update[notesKey(pageKey)] = kept;
      else emptied.push(pageKey);
    }
    if (emptied.length) {
      await area().remove(emptied.map(notesKey));
      const pageKeys = await getPageKeys();
      const remaining = pageKeys.filter((k) => !emptied.includes(k));
      if (remaining.length !== pageKeys.length) update[KEY_PAGES] = remaining;
    }
    if (Object.keys(update).length) await area().set(update);
    await removeShots([...new Set(refs.map((r) => r.noteId))]);
  },

  /**
   * Merge many notes at once (used by import). A note replaces an existing one
   * with the same id only if it is newer. Screenshots are stored only for notes
   * that are written, and hasScreenshot is made to match what is stored.
   */
  async bulkPutNotes(incoming: Note[], screenshots: Record<string, string> = {}): Promise<ImportCounts> {
    const result: ImportCounts = { added: 0, updated: 0, skipped: 0 };
    const byPage = new Map<string, Note[]>();
    for (const note of incoming) {
      const list = byPage.get(note.pageKey) ?? [];
      // A copy: hasScreenshot is adjusted below.
      list.push({ ...migrate(forStorage(note)) });
      byPage.set(note.pageKey, list);
    }

    const pages = await readPages(byPage.keys());
    const written: Note[] = [];
    const changedPages = new Set<string>();
    for (const [pageKey, notes] of byPage) {
      const existing = pages.get(pageKey) ?? [];
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
        written.push(note);
        changedPages.add(pageKey);
      }
    }
    if (!written.length) return result;

    // Screenshots first, so a page reacting to the new notes can load them.
    const shots: Record<string, string> = {};
    for (const note of written) {
      const shot = Object.hasOwn(screenshots, note.id) ? screenshots[note.id] : undefined;
      if (typeof shot === 'string' && shot) shots[note.id] = shot;
    }
    await writeShots(shots);
    const keptLocally = await shotsExist(written.filter((n) => !Object.hasOwn(shots, n.id) && n.hasScreenshot).map((n) => n.id));
    for (const note of written) note.hasScreenshot = Object.hasOwn(shots, note.id) || keptLocally.has(note.id);

    const pageKeys = await getPageKeys();
    const update: Record<string, unknown> = {};
    for (const pageKey of changedPages) update[notesKey(pageKey)] = (pages.get(pageKey) ?? []).sort(byCreatedAt);
    const newPages = [...changedPages].filter((k) => !pageKeys.includes(k));
    if (newPages.length) update[KEY_PAGES] = [...pageKeys, ...newPages];
    await area().set(update);
    return result;
  },

  /** Remove every note and screenshot. Settings are kept. */
  async deleteAllNotes(): Promise<void> {
    const keys = (await storedKeys()).filter(
      (k) => k === KEY_PAGES || k === KEY_PENDING_FOCUS || k.startsWith(NOTES_PREFIX) || k.startsWith(LEGACY_SHOT_PREFIX),
    );
    if (keys.length) await area().remove(keys);
    if (await useIdb()) await shotDb.clear();
  },

  async saveScreenshot(noteId: string, dataUrl: string): Promise<void> {
    await writeShots({ [noteId]: dataUrl });
  },

  async getScreenshot(noteId: string): Promise<string | undefined> {
    await migration;
    return readShot(noteId);
  },

  async getScreenshots(noteIds: string[]): Promise<Record<string, string>> {
    await migration;
    const entries = await Promise.all(noteIds.map(async (id) => [id, await readShot(id)] as const));
    return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined));
  },

  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await getSettings()), ...patch };
    await area().set({ [KEY_SETTINGS]: next });
    return next;
  },

  async setPendingFocus(pageKey: string, noteId: string): Promise<void> {
    const value: PendingFocus = { pageKey, noteId, at: Date.now() };
    await area().set({ [KEY_PENDING_FOCUS]: value });
  },

  /** Returns and clears the pending note id if it targets this page and is recent. */
  async takePendingFocus(pageKey: string): Promise<string | undefined> {
    const res = await area().get(KEY_PENDING_FOCUS);
    const pending = res[KEY_PENDING_FOCUS] as PendingFocus | undefined;
    if (!pending || pending.pageKey !== pageKey) return undefined;
    await area().remove(KEY_PENDING_FOCUS);
    return Date.now() - pending.at < PENDING_FOCUS_TTL_MS ? pending.noteId : undefined;
  },
};

type Writer = typeof writer;
export type StorageOp = keyof Writer;

/** Read-only operations: never queued behind writes. */
const READ_OPS = new Set<StorageOp>(['getScreenshot', 'getScreenshots']);

// ---------------------------------------------------------------------------
// Routing: run here (writer) or ask the background (client)
// ---------------------------------------------------------------------------

/**
 * - writer: performs writes itself (the background; also any context with no
 *   background to talk to, such as unit tests)
 * - client: sends every write to the background
 */
export type StorageRole = 'writer' | 'client';

let roleOverride: StorageRole | undefined;
let detectedRole: StorageRole | undefined;

/**
 * Content scripts have no tabs API, and extension pages share the extension's
 * origin (the background claims the writer role at startup, see
 * registerStorageWriter). Any other context has no background to reach.
 */
function detectRole(): StorageRole {
  try {
    if (!browser.tabs) return 'client';
    return globalThis.location?.href.startsWith(browser.runtime.getURL('/' as PublicPath)) ? 'client' : 'writer';
  } catch {
    return 'client';
  }
}

function role(): StorageRole {
  return roleOverride ?? (detectedRole ??= detectRole());
}

/** Overrides the detected role of this JS context; `undefined` restores detection. For tests. */
export function setStorageRole(next: StorageRole | undefined): void {
  roleOverride = next;
}

/** Run an operation in this context, through the write queue unless it only reads. */
function perform<K extends StorageOp>(op: K, args: readonly unknown[]): ReturnType<Writer[K]> {
  const task = () => (writer[op] as (...a: readonly unknown[]) => Promise<unknown>)(...args);
  return (READ_OPS.has(op) ? task() : queued(task)) as ReturnType<Writer[K]>;
}

/** Ask the background writer to run an operation. */
async function request(op: StorageOp, args: readonly unknown[]): Promise<unknown> {
  // Chrome serialises messages as JSON, where a trailing undefined would arrive as null.
  const sent = [...args];
  while (sent.length && sent[sent.length - 1] === undefined) sent.pop();
  const message: StorageRequest = { type: STORAGE_REQUEST, op, args: sent };
  const response: unknown = await browser.runtime.sendMessage(message);
  if (typeof response === 'object' && response !== null) {
    const { ok, value, error } = response as { ok?: unknown; value?: unknown; error?: unknown };
    if (ok === true) return value;
    if (typeof error === 'string') throw new Error(error);
  }
  throw new Error("WebMark's background page did not answer");
}

function call<K extends StorageOp>(op: K, ...args: Parameters<Writer[K]>): ReturnType<Writer[K]> {
  if (role() === 'writer') return perform(op, args);
  const send = () => request(op, args);
  return (READ_OPS.has(op) ? send() : queued(send)) as ReturnType<Writer[K]>;
}

// ---------------------------------------------------------------------------
// The background: the one writer
// ---------------------------------------------------------------------------

function isExtensionPage(sender: Browser.runtime.MessageSender): boolean {
  return !!sender.url?.startsWith(browser.runtime.getURL('/' as PublicPath));
}

async function handleRequest(message: StorageRequest, sender: Browser.runtime.MessageSender): Promise<{ ok: true; value: unknown }> {
  const { op, args } = checkStorageRequest(message, isExtensionPage(sender));
  return { ok: true, value: await perform(op, args) };
}

/**
 * Make this context (the background) the one that performs every write, for
 * itself and for the `wm:storage` requests of all other contexts. The message
 * listener is registered synchronously, so an MV3 service worker woken by a
 * request receives it. Then older storage layouts are migrated, before any
 * queued write runs. Returns a function that unregisters the listener.
 */
export function registerStorageWriter(): () => void {
  roleOverride = 'writer';
  const unlisten = listen(isStorageRequest, handleRequest);
  migration = queued(migrateStorage).catch((error: unknown) => {
    // Everything keeps working on the old layout; the next start tries again.
    console.warn('WebMark: storage migration failed', error);
  });
  return unlisten;
}

// ---------------------------------------------------------------------------
// Migration (writer only, once per layout version)
// ---------------------------------------------------------------------------

const MIGRATION_BATCH = 20;

async function migrateStorage(): Promise<void> {
  const version = (await area().get(KEY_STORAGE_VERSION))[KEY_STORAGE_VERSION];
  if (typeof version === 'number' && version >= STORAGE_VERSION) {
    legacyShotsMayExist = false;
    return;
  }
  await removeCredentialsFromNotes();
  if (!(await useIdb())) return;
  await moveLegacyScreenshots();
  legacyShotsMayExist = false;
  await area().set({ [KEY_STORAGE_VERSION]: STORAGE_VERSION });
}

/** wm:shot:* keys → IndexedDB, a batch at a time: copy, then delete the originals. */
async function moveLegacyScreenshots(): Promise<void> {
  const keys = (await storedKeys()).filter((k) => k.startsWith(LEGACY_SHOT_PREFIX));
  for (let i = 0; i < keys.length; i += MIGRATION_BATCH) {
    const batch = keys.slice(i, i + MIGRATION_BATCH);
    const stored = await area().get(batch);
    const entries = Object.fromEntries(
      batch
        .filter((key) => typeof stored[key] === 'string')
        .map((key) => [key.slice(LEGACY_SHOT_PREFIX.length), stored[key] as string]),
    );
    await shotDb.put(entries);
    await area().remove(batch);
  }
}

/**
 * Notes saved before credentials were dropped from page keys (see
 * SENSITIVE_PARAMS in url.ts) move to their new key, so the page still finds
 * them; credentials in their saved URLs are redacted.
 */
async function removeCredentialsFromNotes(): Promise<void> {
  const pageKeys = await getPageKeys();
  const stored = await readPages(pageKeys);
  const pages = new Map<string, Note[]>();
  let changed = false;
  for (const pageKey of pageKeys) {
    const key = sanitizePageKey(pageKey);
    if (key !== pageKey) changed = true;
    const notes = (stored.get(pageKey) ?? []).map((note) => {
      const clean = forStorage(note);
      if (clean === note && note.pageKey === key) return note;
      changed = true;
      return { ...clean, pageKey: key };
    });
    const merged = new Map((pages.get(key) ?? []).map((n) => [n.id, n]));
    for (const note of notes) {
      const other = merged.get(note.id);
      if (!other || note.updatedAt > other.updatedAt) merged.set(note.id, note);
    }
    pages.set(key, [...merged.values()]);
  }
  if (!changed) return;

  const update: Record<string, unknown> = { [KEY_PAGES]: [...pages.keys()] };
  for (const [key, notes] of pages) if (notes.length) update[notesKey(key)] = notes.sort(byCreatedAt);
  // Write the new keys before removing the old ones: an interruption leaves a stray copy, never a loss.
  await area().set(update);
  const renamed = pageKeys.filter((k) => !pages.has(k));
  if (renamed.length) await area().remove(renamed.map(notesKey));
}

// ---------------------------------------------------------------------------
// Public write API (same in every context)
// ---------------------------------------------------------------------------

/** Insert or replace a note (matched by id within its page). */
export function saveNote(note: Note): Promise<Note> {
  return call('saveNote', note);
}

/** Apply a partial change and bump updatedAt. Returns undefined if the note no longer exists. */
export function updateNote(pageKey: string, noteId: string, patch: NotePatch): Promise<Note | undefined> {
  return call('updateNote', pageKey, noteId, patch);
}

/**
 * updateNote() for many notes with one storage write, so every page is
 * broadcast once. Results are in the order of `changes`.
 */
export function updateNotes(changes: NoteUpdate[]): Promise<(Note | undefined)[]> {
  return changes.length ? call('updateNotes', changes) : Promise.resolve([]);
}

export function deleteNote(pageKey: string, noteId: string): Promise<void> {
  return call('deleteNote', pageKey, noteId);
}

/** deleteNote() for many notes with one storage write per page. */
export function deleteNotes(refs: NoteRef[]): Promise<void> {
  return refs.length ? call('deleteNotes', refs) : Promise.resolve();
}

/** Import requests stay well below the browsers' message size limits (Chrome: 64 MiB). */
const IMPORT_CHUNK_BYTES = 8 * 1024 * 1024;

/** Split an import into requests of at most IMPORT_CHUNK_BYTES, keeping each page's notes together where possible. */
function importChunks(notes: Note[], screenshots: Record<string, string>): { notes: Note[]; screenshots: Record<string, string> }[] {
  const chunks: { notes: Note[]; screenshots: Record<string, string> }[] = [];
  let current = { notes: [] as Note[], screenshots: {} as Record<string, string> };
  let bytes = 0;
  const byPage = [...notes].sort((a, b) => (a.pageKey < b.pageKey ? -1 : a.pageKey > b.pageKey ? 1 : 0));
  for (const note of byPage) {
    const shot = Object.hasOwn(screenshots, note.id) ? screenshots[note.id] : undefined;
    const size = JSON.stringify(note).length + (shot?.length ?? 0);
    if (current.notes.length && bytes + size > IMPORT_CHUNK_BYTES) {
      chunks.push(current);
      current = { notes: [], screenshots: {} };
      bytes = 0;
    }
    current.notes.push(note);
    if (shot) current.screenshots[note.id] = shot;
    bytes += size;
  }
  if (current.notes.length) chunks.push(current);
  return chunks;
}

/**
 * Merge many notes at once (used by import). A note replaces an existing one
 * with the same id only if it is newer; its screenshot is stored only then.
 * Returns counts for the import summary.
 */
export async function bulkPutNotes(incoming: Note[], screenshots: Record<string, string> = {}): Promise<ImportCounts> {
  if (role() === 'writer') return call('bulkPutNotes', incoming, screenshots);
  const total: ImportCounts = { added: 0, updated: 0, skipped: 0 };
  for (const chunk of importChunks(incoming, screenshots)) {
    const counts = await call('bulkPutNotes', chunk.notes, chunk.screenshots);
    total.added += counts.added;
    total.updated += counts.updated;
    total.skipped += counts.skipped;
  }
  return total;
}

/** Remove every note and screenshot. Settings are kept. */
export function deleteAllNotes(): Promise<void> {
  return call('deleteAllNotes');
}

export function saveScreenshot(noteId: string, dataUrl: string): Promise<void> {
  return call('saveScreenshot', noteId, dataUrl);
}

/** A note's screenshot (JPEG data URL). Outside the background this is a request to it. */
export function getScreenshot(noteId: string): Promise<string | undefined> {
  return call('getScreenshot', noteId);
}

/** Screenshots of several notes (noteId → data URL); notes without one are left out. */
export async function getScreenshots(noteIds: string[]): Promise<Record<string, string>> {
  if (role() === 'writer') return call('getScreenshots', noteIds);
  // Small requests: each answer carries up to ~300 KB per screenshot.
  const found: Record<string, string> = {};
  for (let i = 0; i < noteIds.length; i += 16) Object.assign(found, await call('getScreenshots', noteIds.slice(i, i + 16)));
  return found;
}

export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  return call('saveSettings', patch);
}

// ---------------------------------------------------------------------------
// Pending focus: dashboard/side panel opens a page and asks its content script
// to scroll to a note once it loads.
// ---------------------------------------------------------------------------

export function setPendingFocus(pageKey: string, noteId: string): Promise<void> {
  return call('setPendingFocus', pageKey, noteId);
}

/** Returns and clears the pending note id if it targets this page and is recent. */
export function takePendingFocus(pageKey: string): Promise<string | undefined> {
  return call('takePendingFocus', pageKey);
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
  // `storage` is gone once an extension update orphans a content script, which
  // is exactly when its cleanup unsubscribes; a dead listener has nothing to remove.
  return () => browser.storage?.onChanged.removeListener(listener);
}

export function onSettingsChanged(callback: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
    if (areaName !== 'local' || !(KEY_SETTINGS in changes)) return;
    callback({ ...DEFAULT_SETTINGS, ...((changes[KEY_SETTINGS].newValue as Partial<Settings> | undefined) ?? {}) });
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage?.onChanged.removeListener(listener);
}
