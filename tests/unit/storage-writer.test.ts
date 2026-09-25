import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type * as StorageModule from '@/lib/storage';
import { NOTE_SCHEMA_VERSION, type Note } from '@/lib/types';

/*
 * One writer for all contexts. Each call to context() loads a fresh copy of
 * storage.ts — its own role and write queue, like a separate JS context (a
 * content script, the dashboard, the background) — while all copies share one
 * fake browser, so they talk to each other through runtime messages.
 */

type Storage = typeof StorageModule;

const PAGE_A = 'https://example.com/dashboard';
const PAGE_B = 'https://example.com/settings';
const SHOT = 'data:image/jpeg;base64,/9j/AAAA';

const EXTENSION_PAGE = { url: 'chrome-extension://test-extension-id/options.html' };
const CONTENT_SCRIPT = { url: `${PAGE_A}?tab=1`, tab: { id: 1 }, frameId: 0 };

let seq = 0;

function makeNote(overrides: Partial<Note> = {}): Note {
  seq++;
  return {
    id: `note-${seq}`,
    schemaVersion: NOTE_SCHEMA_VERSION,
    pageKey: PAGE_A,
    url: PAGE_A,
    pageTitle: 'Dashboard',
    label: 'Revenue card',
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

/** A fresh copy of the storage module: the state of one JS context. */
async function context(): Promise<Storage> {
  vi.resetModules();
  return import('@/lib/storage');
}

/** The background: registered as the one writer. */
async function background(): Promise<Storage> {
  const storage = await context();
  storage.registerStorageWriter();
  return storage;
}

/** A content script or extension page: every write goes to the background. */
async function client(): Promise<Storage> {
  const storage = await context();
  storage.setStorageRole('client');
  return storage;
}

type Send = (message: unknown) => Promise<unknown>;

/**
 * Deliver runtime messages like the browser does: to every onMessage listener
 * (the writer's), from `sender`; with no receiver, sending fails.
 */
function sendMessagesAs(sender: object) {
  return vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation((async (message: unknown) => {
    let respond: (value: unknown) => void = () => undefined;
    const response = new Promise((resolve) => (respond = resolve));
    const results: unknown[] = await fakeBrowser.runtime.onMessage.trigger(message, sender, respond);
    if (!results.includes(true)) throw new Error('Could not establish connection. Receiving end does not exist.');
    return response;
  }) as Send as never);
}

/** Send a raw storage request, as a misbehaving context could. */
function rawRequest(op: string, args: unknown[]): Promise<unknown> {
  return fakeBrowser.runtime.sendMessage({ type: 'wm:storage', op, args });
}

/** Wait until the writer's startup migration has run (reads wait for it). */
async function migrated(writer: Storage): Promise<void> {
  await writer.getScreenshot('-');
}

const storedKeys = async () => Object.keys(await fakeBrowser.storage.local.get(null)).sort();

beforeEach(() => {
  fakeBrowser.reset();
  globalThis.indexedDB = new IDBFactory();
});

describe('control: two contexts writing on their own', () => {
  it('interleave their read-modify-write cycles and lose a note', async () => {
    const a = await context();
    const b = await context();
    await Promise.all([a.saveNote(makeNote({ id: 'from-a' })), b.saveNote(makeNote({ id: 'from-b' }))]);
    // This is the bug the single writer fixes (and proof these are separate contexts).
    expect(await a.getNotesForPage(PAGE_A)).toHaveLength(1);
  });
});

describe('the background is the single writer', () => {
  it('receives a client write as a wm:storage request and performs it', async () => {
    const writer = await background();
    const page = await client();
    const send = sendMessagesAs(EXTENSION_PAGE);
    const note = makeNote();

    const saved = await page.saveNote(note);

    expect(send).toHaveBeenCalledWith({ type: 'wm:storage', op: 'saveNote', args: [note] });
    expect(saved).toEqual(note);
    expect(await writer.getNote(PAGE_A, note.id)).toEqual(note);
  });

  it('keeps every note and page when two contexts save at the same time', async () => {
    await background();
    const dashboard = await client();
    const contentScript = await client();
    sendMessagesAs(EXTENSION_PAGE);
    const notes = Array.from({ length: 24 }, (_, i) => makeNote({ id: `n${i}`, pageKey: i % 3 ? PAGE_A : PAGE_B }));

    await Promise.all(notes.map((note, i) => (i % 2 ? dashboard : contentScript).saveNote(note)));

    expect((await dashboard.getAllNotes()).map((n) => n.id).sort()).toEqual(notes.map((n) => n.id).sort());
    expect((await dashboard.getPageKeys()).sort()).toEqual([PAGE_A, PAGE_B].sort());
  });

  it('applies a bulk resolve and an in-page save racing on the same page', async () => {
    await background();
    const dashboard = await client();
    const contentScript = await client();
    sendMessagesAs(EXTENSION_PAGE);
    const existing = Array.from({ length: 10 }, () => makeNote());
    for (const note of existing) await dashboard.saveNote(note);

    const fresh = makeNote({ id: 'fresh' });
    await Promise.all([
      dashboard.updateNotes(existing.map((n) => ({ pageKey: n.pageKey, noteId: n.id, patch: { status: 'resolved' } }))),
      contentScript.saveNote(fresh),
    ]);

    const stored = await dashboard.getNotesForPage(PAGE_A);
    expect(stored.map((n) => n.id)).toContain('fresh');
    expect(stored.filter((n) => n.id !== 'fresh').every((n) => n.status === 'resolved')).toBe(true);
  });

  it('keeps both settings changed from two contexts at once', async () => {
    await background();
    const dashboard = await client();
    const contentScript = await client();
    sendMessagesAs(EXTENSION_PAGE);

    await Promise.all([dashboard.saveSettings({ authorName: 'Dana' }), contentScript.saveSettings({ pinsVisible: false })]);

    expect(await dashboard.getSettings()).toMatchObject({ authorName: 'Dana', pinsVisible: false });
  });

  it('never runs two writes at once, whichever context sent them', async () => {
    await background();
    const a = await client();
    const b = await client();
    sendMessagesAs(EXTENSION_PAGE);
    let inFlight = 0;
    let most = 0;
    const set = fakeBrowser.storage.local.set.bind(fakeBrowser.storage.local);
    vi.spyOn(fakeBrowser.storage.local, 'set').mockImplementation(async (items) => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      await set(items);
      inFlight--;
    });

    await Promise.all([
      a.saveNote(makeNote()),
      b.saveNote(makeNote({ pageKey: PAGE_B })),
      a.saveSettings({ authorName: 'A' }),
      b.updateNotes([{ pageKey: PAGE_A, noteId: 'missing', patch: { body: 'x' } }]),
      b.saveNote(makeNote()),
    ]);

    expect(most).toBe(1);
    expect(await a.getAllNotes()).toHaveLength(3);
  });

  it('answers reads from storage directly, without a message', async () => {
    await background();
    const page = await client();
    const send = sendMessagesAs(EXTENSION_PAGE);
    await page.saveNote(makeNote({ id: 'x' }));
    send.mockClear();

    expect((await page.getNotesForPage(PAGE_A)).map((n) => n.id)).toEqual(['x']);
    expect(await page.getAllNotes()).toHaveLength(1);
    await page.getSettings();
    expect(send).not.toHaveBeenCalled();
  });

  it('serves screenshots to content scripts, which cannot open the extension’s IndexedDB', async () => {
    await background();
    const contentScript = await client();
    sendMessagesAs(CONTENT_SCRIPT);

    await contentScript.saveScreenshot('n1', SHOT);

    expect(await contentScript.getScreenshot('n1')).toBe(SHOT);
    expect(await contentScript.getScreenshot('none')).toBeUndefined();
    expect((await storedKeys()).filter((key) => key.startsWith('wm:shot:'))).toEqual([]);
  });

  it('passes the writer’s errors on to the client', async () => {
    await migrated(await background());
    const page = await client();
    sendMessagesAs(EXTENSION_PAGE);
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES exceeded'));

    await expect(page.saveNote(makeNote())).rejects.toThrow('QUOTA_BYTES exceeded');
    await expect(page.saveNote(makeNote({ id: 'next' }))).resolves.toMatchObject({ id: 'next' });
  });

  it('fails a client write when no background answers, instead of writing itself', async () => {
    const page = await client();
    sendMessagesAs(EXTENSION_PAGE);

    await expect(page.saveNote(makeNote())).rejects.toThrow(/Receiving end does not exist/);
    expect(await storedKeys()).toEqual([]);
  });

  it('stops serving once unregistered', async () => {
    const writer = await context();
    const unregister = writer.registerStorageWriter();
    const page = await client();
    sendMessagesAs(EXTENSION_PAGE);
    await page.saveSettings({ authorName: 'A' });

    unregister();
    await expect(page.saveSettings({ authorName: 'B' })).rejects.toThrow();
    expect((await page.getSettings()).authorName).toBe('A');
  });

  it('treats a context without a tabs API (a content script) as a client', async () => {
    await background();
    const tabs = fakeBrowser.tabs;
    const send = sendMessagesAs(CONTENT_SCRIPT);
    (fakeBrowser as { tabs?: unknown }).tabs = undefined;
    let contentScript: Storage;
    try {
      contentScript = await context();
      await contentScript.saveSettings({ pinsVisible: false });
    } finally {
      (fakeBrowser as { tabs?: unknown }).tabs = tabs;
    }
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ op: 'saveSettings' }));
    expect((await contentScript.getSettings()).pinsVisible).toBe(false);
  });

  it('sends a large import in several requests below the message size limit', async () => {
    await background();
    const dashboard = await client();
    const send = sendMessagesAs(EXTENSION_PAGE);
    const big = `data:image/jpeg;base64,${'A'.repeat(1_500_000)}`;
    const notes = Array.from({ length: 12 }, (_, i) => makeNote({ id: `i${i}`, hasScreenshot: true }));
    const screenshots = Object.fromEntries(notes.map((n) => [n.id, big]));

    expect(await dashboard.bulkPutNotes(notes, screenshots)).toEqual({ added: 12, updated: 0, skipped: 0 });

    const requests = send.mock.calls.map(([message]) => message as unknown as { op: string; args: [Note[], Record<string, string>] });
    const imports = requests.filter((r) => r.op === 'bulkPutNotes');
    expect(imports.length).toBeGreaterThan(1);
    for (const { args } of imports) expect(JSON.stringify(args).length).toBeLessThan(10 * 1024 * 1024);
    expect(Object.keys(await dashboard.getScreenshots(notes.map((n) => n.id)))).toHaveLength(12);
  });

  it('reads many screenshots in small requests', async () => {
    const writer = await background();
    const dashboard = await client();
    const send = sendMessagesAs(EXTENSION_PAGE);
    const ids = Array.from({ length: 40 }, (_, i) => `s${i}`);
    for (const id of ids) await writer.saveScreenshot(id, SHOT);

    expect(Object.keys(await dashboard.getScreenshots(ids))).toHaveLength(40);
    expect(send.mock.calls.length).toBe(3);
  });
});

describe('the writer checks every request (defence in depth)', () => {
  beforeEach(async () => {
    await background();
    sendMessagesAs(EXTENSION_PAGE);
  });

  it.each([
    ['an unknown operation', 'eval', []],
    ['an inherited property name', 'constructor', []],
    ['a note that is not a note', 'saveNote', [{ id: 1 }]],
    ['a note without an anchor', 'saveNote', [{ ...makeNote(), anchor: 'x' }]],
    ['too few arguments', 'updateNote', [PAGE_A, 'n1']],
    ['too many arguments', 'deleteNote', [PAGE_A, 'n1', 'extra']],
    ['a patch that changes the page', 'updateNote', [PAGE_A, 'n1', { pageKey: PAGE_B }]],
    ['a patch that changes the id', 'updateNotes', [[{ pageKey: PAGE_A, noteId: 'n1', patch: { id: 'other' } }]]],
    ['a patch with a bad status', 'updateNote', [PAGE_A, 'n1', { status: 'done' }]],
    ['an SVG screenshot (it can carry script)', 'saveScreenshot', ['n1', 'data:image/svg+xml;base64,PHN2Zz4=']],
    ['a screenshot that is a link', 'saveScreenshot', ['n1', 'https://evil.example/pixel.png']],
    ['an import with a bad screenshot', 'bulkPutNotes', [[makeNote()], { x: 'javascript:alert(1)' }]],
    ['a bad setting', 'saveSettings', [{ pinsVisible: 'yes' }]],
    ['an unknown setting that is not a plain value', 'saveSettings', [{ theme: { dark: true } }]],
    ['an empty page key', 'takePendingFocus', ['']],
  ])('refuses %s', async (_name, op, args) => {
    const response = (await rawRequest(op, args)) as { error?: string };
    expect(response.error).toMatch(/storage operation|argument/i);
    expect(await storedKeys()).toEqual([]);
  });

  it('accepts settings added later, as plain values', async () => {
    expect(await rawRequest('saveSettings', [{ editorWidth: 360 }])).toMatchObject({ ok: true });
  });

  it('passes fields added to notes later through unchanged', async () => {
    const note = { ...makeNote({ id: 'future' }), anchor: { ...makeNote().anchor, shadowPath: ['acme-card'] } };
    await rawRequest('saveNote', [note]);
    expect((await fakeBrowser.storage.local.get(`wm:notes:${PAGE_A}`))[`wm:notes:${PAGE_A}`]).toEqual([note]);
  });
});

describe('content scripts may only change single notes', () => {
  beforeEach(async () => {
    await background();
    sendMessagesAs(CONTENT_SCRIPT);
  });

  it('may save, update and delete a note, screenshots and settings', async () => {
    const contentScript = await client();
    const note = await contentScript.saveNote(makeNote({ id: 'x' }));
    await contentScript.updateNote(note.pageKey, note.id, { status: 'resolved' });
    await contentScript.saveSettings({ pinsVisible: false });
    await contentScript.deleteNote(note.pageKey, note.id);
    expect(await contentScript.getAllNotes()).toEqual([]);
  });

  it.each([
    ['delete everything', (s: Storage) => s.deleteAllNotes()],
    ['import notes', (s: Storage) => s.bulkPutNotes([makeNote()])],
    ['bulk-update notes', (s: Storage) => s.updateNotes([{ pageKey: PAGE_A, noteId: 'x', patch: { status: 'resolved' } }])],
    ['bulk-delete notes', (s: Storage) => s.deleteNotes([{ pageKey: PAGE_A, noteId: 'x' }])],
    ['set where another page opens', (s: Storage) => s.setPendingFocus(PAGE_A, 'x')],
  ])('may not %s', async (_name, action) => {
    await expect(action(await client())).rejects.toThrow(/only available to WebMark's own pages/);
  });
});

describe('startup migration', () => {
  it('moves wm:shot:* screenshots into IndexedDB and removes them from storage.local', async () => {
    await fakeBrowser.storage.local.set({
      'wm:pages': [PAGE_A],
      [`wm:notes:${PAGE_A}`]: [makeNote({ id: 'a', hasScreenshot: true })],
      'wm:shot:a': SHOT,
      'wm:shot:orphan': `${SHOT}B`,
    });
    const writer = await background();
    await migrated(writer);

    expect(await storedKeys()).toEqual(['wm:notes:' + PAGE_A, 'wm:pages', 'wm:storage-version']);
    expect((await fakeBrowser.storage.local.get('wm:storage-version'))['wm:storage-version']).toBe(2);
    expect(await writer.getScreenshots(['a', 'orphan'])).toEqual({ a: SHOT, orphan: `${SHOT}B` });
  });

  it('moves notes saved with credentials in their page key, and redacts their saved URLs', async () => {
    const legacyKey = `${PAGE_A}?id=5&token=abc`;
    const cleanKey = `${PAGE_A}?id=5`;
    await fakeBrowser.storage.local.set({
      'wm:pages': [legacyKey, cleanKey, PAGE_B],
      [`wm:notes:${legacyKey}`]: [
        makeNote({ id: 'old1', pageKey: legacyKey, url: `${legacyKey}#access_token=zzz`, createdAt: 1 }),
        makeNote({ id: 'old2', pageKey: legacyKey, url: legacyKey, createdAt: 3 }),
      ],
      [`wm:notes:${cleanKey}`]: [makeNote({ id: 'clean', pageKey: cleanKey, url: cleanKey, createdAt: 2 })],
      [`wm:notes:${PAGE_B}`]: [makeNote({ id: 'b', pageKey: PAGE_B, url: PAGE_B })],
    });
    const writer = await background();
    await migrated(writer);

    expect(await writer.getPageKeys()).toEqual([cleanKey, PAGE_B]);
    const notes = await writer.getNotesForPage(cleanKey);
    expect(notes.map((n) => [n.id, n.pageKey])).toEqual([
      ['old1', cleanKey],
      ['clean', cleanKey],
      ['old2', cleanKey],
    ]);
    expect(notes[0]?.url).toBe(`${PAGE_A}?id=5&token=REDACTED#access_token=REDACTED`);
    expect(notes[2]?.url).toBe(`${PAGE_A}?id=5&token=REDACTED`);
    expect(await storedKeys()).not.toContain(`wm:notes:${legacyKey}`);
    expect((await writer.getNotesForPage(PAGE_B)).map((n) => n.id)).toEqual(['b']);
  });

  it('runs once: a store already at the current version is left alone', async () => {
    const legacyKey = `${PAGE_A}?token=abc`;
    await fakeBrowser.storage.local.set({
      'wm:storage-version': 2,
      'wm:pages': [legacyKey],
      [`wm:notes:${legacyKey}`]: [makeNote({ id: 'x', pageKey: legacyKey })],
    });
    const get = vi.spyOn(fakeBrowser.storage.local, 'get');
    const writer = await background();
    await migrated(writer);

    expect(await writer.getPageKeys()).toEqual([legacyKey]);
    expect(get.mock.calls.map(([keys]) => keys)).not.toContainEqual(null);
  });

  it('makes writes that arrive during startup wait for it', async () => {
    const legacyKey = `${PAGE_A}?token=abc`;
    await fakeBrowser.storage.local.set({
      'wm:pages': [legacyKey],
      [`wm:notes:${legacyKey}`]: [makeNote({ id: 'x', pageKey: legacyKey })],
    });
    sendMessagesAs(CONTENT_SCRIPT);
    const contentScript = await client();
    await background();

    // The content script already uses the new page key.
    expect(await contentScript.updateNote(PAGE_A, 'x', { status: 'resolved' })).toMatchObject({ id: 'x', status: 'resolved' });
  });

  it('keeps screenshots in storage.local when IndexedDB is unavailable, and tries again next start', async () => {
    Reflect.deleteProperty(globalThis, 'indexedDB');
    await fakeBrowser.storage.local.set({ 'wm:shot:old': SHOT });
    const writer = await background();
    await migrated(writer);

    await writer.saveScreenshot('new', `${SHOT}N`);
    expect(await writer.getScreenshots(['old', 'new'])).toEqual({ old: SHOT, new: `${SHOT}N` });
    expect(await storedKeys()).toEqual(['wm:shot:new', 'wm:shot:old', 'wm:storage-version']);
    expect((await fakeBrowser.storage.local.get('wm:storage-version'))['wm:storage-version']).toBe(1);

    // Next start, with IndexedDB back: both move over.
    globalThis.indexedDB = new IDBFactory();
    const next = await background();
    await migrated(next);
    expect(await storedKeys()).toEqual(['wm:storage-version']);
    expect(await next.getScreenshots(['old', 'new'])).toEqual({ old: SHOT, new: `${SHOT}N` });
  });
});
