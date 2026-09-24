import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { buildExportBundle, downloadFile, importBundle, parseExportBundle, type ExportBundle } from '@/lib/export';
import { getAllNotes, getNote, getScreenshot, getSettings, saveNote, saveScreenshot, saveSettings } from '@/lib/storage';
import { NOTE_SCHEMA_VERSION, type Note } from '@/lib/types';

const PAGE_A = 'https://example.com/dashboard';
const PAGE_B = 'https://example.com/settings';
const SHOT = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const SHOT_2 = 'data:image/png;base64,iVBORw0KGgo=';

let seq = 0;

function makeNote(overrides: Partial<Note> = {}): Note {
  seq++;
  return {
    id: `note-${seq}`,
    schemaVersion: NOTE_SCHEMA_VERSION,
    pageKey: PAGE_A,
    url: `${PAGE_A}?tab=1`,
    pageTitle: 'Dashboard',
    label: 'Dashboard → Revenue Card',
    body: `Body ${seq}`,
    status: 'open',
    tags: ['bug'],
    author: 'Alice',
    anchor: {
      selector: '#revenue',
      xpath: '/html/body/div[1]',
      tagName: 'div',
      id: 'revenue',
      classes: ['card'],
      attributes: { 'data-testid': 'revenue-card' },
      text: 'Revenue',
      rect: { x: 1, y: 2, width: 300, height: 120 },
      viewport: { width: 1280, height: 800 },
      ancestorTags: ['main', 'body'],
      nthOfType: 2,
    },
    hasScreenshot: false,
    createdAt: 1_000 + seq,
    updatedAt: 1_000 + seq,
    ...overrides,
  };
}

function bundleJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ format: 'webmark', version: 1, exportedAt: 123, notes: [], screenshots: {}, ...overrides });
}

/** A serialised note with one field changed or removed, as a hand-edited file might have. */
function rawNote(patch: Record<string, unknown> = {}, remove: string[] = []): Record<string, unknown> {
  const note: Record<string, unknown> = { ...makeNote(), ...patch };
  for (const key of remove) delete note[key];
  return note;
}

function rawAnchor(patch: Record<string, unknown> = {}, remove: string[] = []): Record<string, unknown> {
  const anchor: Record<string, unknown> = { ...makeNote().anchor, ...patch };
  for (const key of remove) delete anchor[key];
  return anchor;
}

beforeEach(() => {
  fakeBrowser.reset();
});

// ---------------------------------------------------------------------------

describe('buildExportBundle', () => {
  it('exports every stored note with screenshots by default', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(42_000);
    const a = await saveNote(makeNote({ hasScreenshot: true }));
    const b = await saveNote(makeNote({ pageKey: PAGE_B }));
    await saveScreenshot(a.id, SHOT);

    const bundle = await buildExportBundle();

    expect(bundle.format).toBe('webmark');
    expect(bundle.version).toBe(1);
    expect(bundle.exportedAt).toBe(42_000);
    expect(bundle.notes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(bundle.screenshots).toEqual({ [a.id]: SHOT });
  });

  it('leaves screenshots out on request', async () => {
    const a = await saveNote(makeNote({ hasScreenshot: true }));
    await saveScreenshot(a.id, SHOT);

    const bundle = await buildExportBundle({ includeScreenshots: false });
    expect(bundle.screenshots).toEqual({});
    expect(bundle.notes).toHaveLength(1);
  });

  it('exports only the given notes', async () => {
    const a = await saveNote(makeNote({ hasScreenshot: true }));
    const b = await saveNote(makeNote({ hasScreenshot: true }));
    await saveScreenshot(a.id, SHOT);
    await saveScreenshot(b.id, SHOT_2);

    const bundle = await buildExportBundle({ notes: [b] });
    expect(bundle.notes).toEqual([b]);
    expect(bundle.screenshots).toEqual({ [b.id]: SHOT_2 });
  });

  it('skips screenshots that are flagged but missing', async () => {
    await saveNote(makeNote({ hasScreenshot: true }));
    expect((await buildExportBundle()).screenshots).toEqual({});
  });
});

// ---------------------------------------------------------------------------

describe('parseExportBundle', () => {
  it('round-trips an exported bundle', async () => {
    const a = await saveNote(makeNote({ hasScreenshot: true, status: 'resolved' }));
    await saveNote(makeNote({ pageKey: PAGE_B, tags: [] }));
    await saveScreenshot(a.id, SHOT);

    const bundle = await buildExportBundle();
    const parsed = parseExportBundle(JSON.stringify(bundle));

    expect(parsed).toEqual(bundle);
  });

  it('fills optional fields with defaults', () => {
    const minimalAnchor = { selector: 'p', xpath: '/html/body/p', tagName: 'p' };
    const note = rawNote({ anchor: minimalAnchor }, ['author', 'hasScreenshot', 'schemaVersion']);
    const parsed = parseExportBundle(bundleJson({ notes: [note] }));

    expect(parsed.notes[0]).toMatchObject({
      author: '',
      hasScreenshot: false,
      schemaVersion: NOTE_SCHEMA_VERSION,
      anchor: {
        selector: 'p',
        xpath: '/html/body/p',
        tagName: 'p',
        classes: [],
        attributes: {},
        text: '',
        rect: { x: 0, y: 0, width: 0, height: 0 },
        viewport: { width: 0, height: 0 },
        ancestorTags: [],
        nthOfType: 1,
      },
    });
    expect(parsed.notes[0]?.anchor).not.toHaveProperty('id');
  });

  it('strips unknown properties at every level', () => {
    const note = rawNote({ evil: true, anchor: rawAnchor({ onload: 'x' }) });
    const parsed = parseExportBundle(bundleJson({ notes: [note], extra: 'nope', exportedAt: 'soon' }));

    expect(Object.keys(parsed).sort()).toEqual(['exportedAt', 'format', 'notes', 'screenshots', 'version']);
    expect(parsed.exportedAt).toBe(0);
    expect(parsed.notes[0]).not.toHaveProperty('evil');
    expect(parsed.notes[0]?.anchor).not.toHaveProperty('onload');
  });

  it('keeps a "__proto__" attribute as plain data', () => {
    const json = bundleJson({ notes: [rawNote({ anchor: rawAnchor({ attributes: {} }) })] }).replace(
      '"attributes":{}',
      '"attributes":{"__proto__":"x","role":"button"}',
    );
    const parsed = parseExportBundle(json);
    const attributes = parsed.notes[0]?.anchor.attributes ?? {};

    expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype);
    expect(Object.keys(attributes).sort()).toEqual(['__proto__', 'role']);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('accepts only raster image data URLs for known notes as screenshots', () => {
    const a = rawNote({ hasScreenshot: true });
    const b = rawNote({ hasScreenshot: true });
    const c = rawNote({ hasScreenshot: true });
    const d = rawNote({ hasScreenshot: true });
    const parsed = parseExportBundle(
      bundleJson({
        notes: [a, b, c, d],
        screenshots: {
          [a.id as string]: SHOT,
          [b.id as string]: 'https://evil.example/track.png',
          [c.id as string]: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
          [d.id as string]: 42,
          unknown: SHOT,
        },
      }),
    );
    expect(parsed.screenshots).toEqual({ [a.id as string]: SHOT });
  });

  it('treats a non-object screenshots value as none', () => {
    expect(parseExportBundle(bundleJson({ screenshots: 'x' })).screenshots).toEqual({});
    expect(parseExportBundle(bundleJson({ screenshots: undefined })).screenshots).toEqual({});
  });

  it('accepts an empty export', () => {
    expect(parseExportBundle(bundleJson()).notes).toEqual([]);
  });

  it.each([
    ['not JSON', '{oops', 'This file is not valid JSON'],
    ['a JSON array', '[]', 'This file is not a WebMark export.'],
    ['null', 'null', 'This file is not a WebMark export.'],
    ['another format', bundleJson({ format: 'other' }), 'This file is not a WebMark export.'],
    ['a newer version', bundleJson({ version: 2 }), 'newer version of WebMark (format version 2)'],
    ['a bogus version', bundleJson({ version: '1' }), 'unknown WebMark format version'],
    ['no version', bundleJson({ version: undefined }), 'unknown WebMark format version'],
    ['no notes list', bundleJson({ notes: undefined }), "has no 'notes' list"],
    ['a notes object', bundleJson({ notes: {} }), "has no 'notes' list"],
  ])('rejects %s', (_name, json, message) => {
    expect(() => parseExportBundle(json)).toThrow(message);
  });

  it.each([
    ['a missing body', rawNote({}, ['body']), "Note 2 is missing 'body'."],
    ['a null id', rawNote({ id: null }), "Note 2 is missing 'id'."],
    ['an empty id', rawNote({ id: ' ' }), "Note 2 has an invalid 'id' (expected non-empty text)."],
    ['a missing pageKey', rawNote({}, ['pageKey']), "Note 2 is missing 'pageKey'."],
    ['a numeric url', rawNote({ url: 5 }), "Note 2 has an invalid 'url' (expected text)."],
    ['a missing pageTitle', rawNote({}, ['pageTitle']), "Note 2 is missing 'pageTitle'."],
    ['a missing label', rawNote({}, ['label']), "Note 2 is missing 'label'."],
    ['an unknown status', rawNote({ status: 'done' }), "Note 2 has an invalid 'status' (expected 'open' or 'resolved')."],
    ['tags as a string', rawNote({ tags: 'bug' }), "Note 2 has an invalid 'tags' (expected a list of text)."],
    ['non-text tags', rawNote({ tags: ['ok', 3] }), "Note 2 has an invalid 'tags' (expected a list of text)."],
    ['a text createdAt', rawNote({ createdAt: '2026-01-01' }), "Note 2 has an invalid 'createdAt' (expected a number)."],
    ['a missing updatedAt', rawNote({}, ['updatedAt']), "Note 2 is missing 'updatedAt'."],
    ['a text hasScreenshot', rawNote({ hasScreenshot: 'yes' }), "Note 2 has an invalid 'hasScreenshot' (expected true or false)."],
    ['a numeric author', rawNote({ author: 1 }), "Note 2 has an invalid 'author' (expected text)."],
    ['a missing anchor', rawNote({}, ['anchor']), "Note 2 is missing 'anchor'."],
    ['an anchor string', rawNote({ anchor: '#x' }), "Note 2 has an invalid 'anchor' (expected an object)."],
    ['a missing selector', rawNote({ anchor: rawAnchor({}, ['selector']) }), "Note 2 is missing 'anchor.selector'."],
    ['a missing xpath', rawNote({ anchor: rawAnchor({}, ['xpath']) }), "Note 2 is missing 'anchor.xpath'."],
    ['a numeric tagName', rawNote({ anchor: rawAnchor({ tagName: 1 }) }), "Note 2 has an invalid 'anchor.tagName' (expected text)."],
    ['bad classes', rawNote({ anchor: rawAnchor({ classes: [1] }) }), "Note 2 has an invalid 'anchor.classes' (expected a list of text)."],
    ['bad attributes', rawNote({ anchor: rawAnchor({ attributes: { a: 1 } }) }), "Note 2 has an invalid 'anchor.attributes' (expected an object of text values)."],
    ['a partial rect', rawNote({ anchor: rawAnchor({ rect: { x: 1, y: 2, width: 3 } }) }), "Note 2 is missing 'anchor.rect.height'."],
    ['a text viewport width', rawNote({ anchor: rawAnchor({ viewport: { width: '1', height: 2 } }) }), "Note 2 has an invalid 'anchor.viewport.width' (expected a number)."],
    ['a text nthOfType', rawNote({ anchor: rawAnchor({ nthOfType: 'first' }) }), "Note 2 has an invalid 'anchor.nthOfType' (expected a number)."],
  ])('rejects a note with %s', (_name, note, message) => {
    expect(() => parseExportBundle(bundleJson({ notes: [rawNote(), note] }))).toThrow(message);
  });

  it('rejects a note that is not an object', () => {
    expect(() => parseExportBundle(bundleJson({ notes: [rawNote(), rawNote(), 'x'] }))).toThrow(
      'Note 3 is not a valid note.',
    );
  });

  it('rejects infinite numbers written as huge literals', () => {
    const json = bundleJson({ notes: [rawNote({ createdAt: 0 })] }).replace('"createdAt":0', '"createdAt":1e999');
    expect(() => parseExportBundle(json)).toThrow("Note 1 has an invalid 'createdAt' (expected a number).");
  });

  it('rejects duplicate note ids', () => {
    const note = rawNote();
    expect(() => parseExportBundle(bundleJson({ notes: [note, rawNote(), { ...note }] }))).toThrow(
      'Note 3 has the same id as note 1.',
    );
  });
});

// ---------------------------------------------------------------------------

describe('importBundle', () => {
  function bundleOf(notes: Note[], screenshots: Record<string, string> = {}): ExportBundle {
    return { format: 'webmark', version: 1, exportedAt: 0, notes, screenshots };
  }

  it('merge keeps existing notes and lets the newer copy win', async () => {
    const localOnly = await saveNote(makeNote({ body: 'local only' }));
    const shared = await saveNote(makeNote({ body: 'local', updatedAt: 500 }));
    const stale = await saveNote(makeNote({ body: 'local newer', updatedAt: 900 }));

    const summary = await importBundle(
      bundleOf([
        { ...shared, body: 'incoming', updatedAt: 600 },
        { ...stale, body: 'incoming older', updatedAt: 800 },
        makeNote({ pageKey: PAGE_B, body: 'new page' }),
      ]),
      'merge',
    );

    expect(summary).toEqual({ added: 1, updated: 1, skipped: 1 });
    expect((await getNote(PAGE_A, localOnly.id))?.body).toBe('local only');
    expect((await getNote(PAGE_A, shared.id))?.body).toBe('incoming');
    expect((await getNote(PAGE_A, stale.id))?.body).toBe('local newer');
    expect(await getAllNotes()).toHaveLength(4);
  });

  it('replace removes notes and screenshots that are not in the file, but keeps settings', async () => {
    await saveSettings({ authorName: 'Alice' });
    const old = await saveNote(makeNote({ hasScreenshot: true }));
    await saveScreenshot(old.id, SHOT);
    const incoming = makeNote({ pageKey: PAGE_B });

    const summary = await importBundle(bundleOf([incoming]), 'replace');

    expect(summary).toEqual({ added: 1, updated: 0, skipped: 0 });
    expect((await getAllNotes()).map((n) => n.id)).toEqual([incoming.id]);
    expect(await getScreenshot(old.id)).toBeUndefined();
    expect((await getSettings()).authorName).toBe('Alice');
  });

  it('replace imports older copies too, since nothing local is kept', async () => {
    const local = await saveNote(makeNote({ body: 'local', updatedAt: 900 }));
    await importBundle(bundleOf([{ ...local, body: 'from file', updatedAt: 100 }]), 'replace');
    expect((await getNote(PAGE_A, local.id))?.body).toBe('from file');
  });

  it('stores bundled screenshots and flags their notes', async () => {
    const withShot = makeNote({ hasScreenshot: true });
    const flaggedOff = makeNote({ hasScreenshot: false });
    await importBundle(bundleOf([withShot, flaggedOff], { [withShot.id]: SHOT, [flaggedOff.id]: SHOT_2 }), 'merge');

    expect(await getScreenshot(withShot.id)).toBe(SHOT);
    expect(await getScreenshot(flaggedOff.id)).toBe(SHOT_2);
    expect((await getNote(PAGE_A, flaggedOff.id))?.hasScreenshot).toBe(true);
  });

  it('clears hasScreenshot when the screenshot is not in the file', async () => {
    const note = makeNote({ hasScreenshot: true });
    await importBundle(bundleOf([note]), 'merge');
    expect((await getNote(PAGE_A, note.id))?.hasScreenshot).toBe(false);
  });

  it('keeps hasScreenshot when merging over a local copy that still has its screenshot', async () => {
    const local = await saveNote(makeNote({ hasScreenshot: true, updatedAt: 100 }));
    await saveScreenshot(local.id, SHOT);

    await importBundle(bundleOf([{ ...local, body: 'edited elsewhere', updatedAt: 200 }]), 'merge');

    const stored = await getNote(PAGE_A, local.id);
    expect(stored?.body).toBe('edited elsewhere');
    expect(stored?.hasScreenshot).toBe(true);
    expect(await getScreenshot(local.id)).toBe(SHOT);
  });

  it('clears hasScreenshot on replace even if a screenshot existed before', async () => {
    const local = await saveNote(makeNote({ hasScreenshot: true }));
    await saveScreenshot(local.id, SHOT);

    await importBundle(bundleOf([local]), 'replace');

    expect((await getNote(PAGE_A, local.id))?.hasScreenshot).toBe(false);
    expect(await getScreenshot(local.id)).toBeUndefined();
  });

  it('imports a parsed file end to end', async () => {
    const note = makeNote({ hasScreenshot: true });
    const json = JSON.stringify(bundleOf([note], { [note.id]: SHOT }));

    await importBundle(parseExportBundle(json), 'merge');

    expect(await getAllNotes()).toEqual([note]);
    expect(await getScreenshot(note.id)).toBe(SHOT);
  });
});

// ---------------------------------------------------------------------------

describe('downloadFile', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clicked: HTMLAnchorElement[];

  beforeEach(() => {
    createObjectURL = vi.fn(() => 'blob:webmark/123');
    revokeObjectURL = vi.fn();
    // jsdom implements neither method.
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    clicked = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
      expect(document.body.contains(this)).toBe(true);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** jsdom's Blob only works with jsdom's FileReader, not Node's Response. */
  function blobText(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new TextDecoder('utf-8', { ignoreBOM: true }).decode(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
  }

  it('clicks a temporary link to the blob, then removes it and revokes the URL later', () => {
    vi.useFakeTimers();
    downloadFile('webmark-notes.json', '{"a":1}', 'application/json');

    expect(clicked).toHaveLength(1);
    const link = clicked[0];
    expect(link?.download).toBe('webmark-notes.json');
    expect(link?.getAttribute('href')).toBe('blob:webmark/123');
    expect(document.querySelector('a[download]')).toBeNull();

    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:webmark/123');
  });

  it('puts the contents in a blob of the given type', async () => {
    downloadFile('webmark-notes.json', '{"a":1}', 'application/json');
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('application/json');
    expect(await blobText(blob)).toBe('{"a":1}');
  });

  it('adds a byte-order mark to CSV so Excel reads it as UTF-8', async () => {
    downloadFile('notes.csv', 'id,label\r\n1,→\r\n', 'text/csv;charset=utf-8');
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(await blobText(blob)).toBe('﻿id,label\r\n1,→\r\n');
  });

  it('does not add a byte-order mark to other types', async () => {
    downloadFile('report.md', '# Report', 'text/markdown');
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(await blobText(blob)).toBe('# Report');
  });
});
