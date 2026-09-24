import { bulkPutNotes, deleteAllNotes, getAllNotes, getScreenshot } from './storage';
import { NOTE_SCHEMA_VERSION, type DocRect, type ElementAnchor, type Note, type NoteStatus } from './types';

export interface ExportBundle {
  format: 'webmark';
  version: 1;
  exportedAt: number;
  notes: Note[];
  /** noteId → JPEG data URL. Empty when exported without screenshots. */
  screenshots: Record<string, string>;
}

export interface ImportSummary {
  added: number;
  updated: number;
  skipped: number;
}

const BUNDLE_VERSION = 1;

/** Collect notes (all, or the given subset) and optionally their screenshots. */
export async function buildExportBundle(options?: { includeScreenshots?: boolean; notes?: Note[] }): Promise<ExportBundle> {
  const notes = options?.notes ?? (await getAllNotes());
  const screenshots: Record<string, string> = {};
  if (options?.includeScreenshots ?? true) {
    await Promise.all(
      notes
        .filter((note) => note.hasScreenshot)
        .map(async (note) => {
          const shot = await getScreenshot(note.id);
          if (shot) screenshots[note.id] = shot;
        }),
    );
  }
  return { format: 'webmark', version: BUNDLE_VERSION, exportedAt: Date.now(), notes, screenshots };
}

// ---------------------------------------------------------------------------
// Validation. An import file is untrusted input: every value is checked and
// copied into a fresh object, so unknown or malformed data never reaches storage.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

interface Check<T> {
  test: (value: unknown) => value is T;
  expected: string;
}

/** Where a field lives, for error messages like "Note 3 is missing 'anchor.selector'". */
interface Ctx {
  owner: string;
  path: string;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text: Check<string> = {
  test: (v): v is string => typeof v === 'string',
  expected: 'text',
};
const nonEmptyText: Check<string> = {
  test: (v): v is string => typeof v === 'string' && v.trim() !== '',
  expected: 'non-empty text',
};
const finiteNumber: Check<number> = {
  test: (v): v is number => typeof v === 'number' && Number.isFinite(v),
  expected: 'a number',
};
const boolean: Check<boolean> = {
  test: (v): v is boolean => typeof v === 'boolean',
  expected: 'true or false',
};
const textList: Check<string[]> = {
  test: (v): v is string[] => Array.isArray(v) && v.every((item) => typeof item === 'string'),
  expected: 'a list of text',
};
const textMap: Check<Json> = {
  test: (v): v is Json => isRecord(v) && Object.values(v).every((item) => typeof item === 'string'),
  expected: 'an object of text values',
};
const object: Check<Json> = { test: isRecord, expected: 'an object' };
const status: Check<NoteStatus> = {
  test: (v): v is NoteStatus => v === 'open' || v === 'resolved',
  expected: "'open' or 'resolved'",
};

/** A present value must pass the check; absent (undefined/null) returns undefined. */
function optional<T>(obj: Json, key: string, check: Check<T>, ctx: Ctx): T | undefined {
  const value = Object.hasOwn(obj, key) ? obj[key] : undefined;
  if (value === undefined || value === null) return undefined;
  if (!check.test(value)) throw new Error(`${ctx.owner} has an invalid '${ctx.path}${key}' (expected ${check.expected}).`);
  return value;
}

function required<T>(obj: Json, key: string, check: Check<T>, ctx: Ctx): T {
  const value = optional(obj, key, check, ctx);
  if (value === undefined) throw new Error(`${ctx.owner} is missing '${ctx.path}${key}'.`);
  return value;
}

function nested(ctx: Ctx, key: string): Ctx {
  return { owner: ctx.owner, path: `${ctx.path}${key}.` };
}

function parseRect(raw: Json | undefined, ctx: Ctx): DocRect {
  if (!raw) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: required(raw, 'x', finiteNumber, ctx),
    y: required(raw, 'y', finiteNumber, ctx),
    width: required(raw, 'width', finiteNumber, ctx),
    height: required(raw, 'height', finiteNumber, ctx),
  };
}

function parseViewport(raw: Json | undefined, ctx: Ctx): ElementAnchor['viewport'] {
  if (!raw) return { width: 0, height: 0 };
  return {
    width: required(raw, 'width', finiteNumber, ctx),
    height: required(raw, 'height', finiteNumber, ctx),
  };
}

function parseAnchor(raw: Json, ctx: Ctx): ElementAnchor {
  const anchor: ElementAnchor = {
    selector: required(raw, 'selector', text, ctx),
    xpath: required(raw, 'xpath', text, ctx),
    tagName: required(raw, 'tagName', text, ctx),
    classes: optional(raw, 'classes', textList, ctx) ?? [],
    // fromEntries defines own properties, so a "__proto__" key stays plain data.
    attributes: Object.fromEntries(Object.entries(optional(raw, 'attributes', textMap, ctx) ?? {})) as Record<string, string>,
    text: optional(raw, 'text', text, ctx) ?? '',
    rect: parseRect(optional(raw, 'rect', object, ctx), nested(ctx, 'rect')),
    viewport: parseViewport(optional(raw, 'viewport', object, ctx), nested(ctx, 'viewport')),
    ancestorTags: optional(raw, 'ancestorTags', textList, ctx) ?? [],
    nthOfType: optional(raw, 'nthOfType', finiteNumber, ctx) ?? 1,
  };
  const id = optional(raw, 'id', text, ctx);
  if (id) anchor.id = id;
  return anchor;
}

function parseNote(raw: unknown, index: number): Note {
  const ctx: Ctx = { owner: `Note ${index + 1}`, path: '' };
  if (!isRecord(raw)) throw new Error(`${ctx.owner} is not a valid note.`);
  return {
    id: required(raw, 'id', nonEmptyText, ctx),
    schemaVersion: NOTE_SCHEMA_VERSION,
    pageKey: required(raw, 'pageKey', nonEmptyText, ctx),
    url: required(raw, 'url', text, ctx),
    pageTitle: required(raw, 'pageTitle', text, ctx),
    label: required(raw, 'label', text, ctx),
    body: required(raw, 'body', text, ctx),
    status: required(raw, 'status', status, ctx),
    tags: [...required(raw, 'tags', textList, ctx)],
    author: optional(raw, 'author', text, ctx) ?? '',
    anchor: parseAnchor(required(raw, 'anchor', object, ctx), nested(ctx, 'anchor')),
    hasScreenshot: optional(raw, 'hasScreenshot', boolean, ctx) ?? false,
    createdAt: required(raw, 'createdAt', finiteNumber, ctx),
    updatedAt: required(raw, 'updatedAt', finiteNumber, ctx),
  };
}

/** Raster images only: an SVG data URL can carry script. */
const SCREENSHOT_DATA_URL = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]*$/i;

function parseScreenshots(raw: unknown, noteIds: Set<string>): Record<string, string> {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([id, value]) => noteIds.has(id) && typeof value === 'string' && SCREENSHOT_DATA_URL.test(value),
    ),
  ) as Record<string, string>;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new Error('This file is not valid JSON. Choose a .json file exported from WebMark.');
  }
}

function checkVersion(version: unknown): void {
  if (version === BUNDLE_VERSION) return;
  if (typeof version === 'number' && version > BUNDLE_VERSION) {
    throw new Error(
      `This file was exported by a newer version of WebMark (format version ${version}). Update WebMark and try again.`,
    );
  }
  throw new Error('This file has an unknown WebMark format version, so it cannot be imported.');
}

/** Parse and validate a bundle; throws an Error with a user-friendly message if invalid. */
export function parseExportBundle(json: string): ExportBundle {
  const data = parseJson(json);
  if (!isRecord(data) || data.format !== 'webmark') {
    throw new Error('This file is not a WebMark export.');
  }
  checkVersion(data.version);
  if (!Array.isArray(data.notes)) {
    throw new Error("This WebMark export is damaged: it has no 'notes' list.");
  }

  const notes = data.notes.map(parseNote);
  const firstIndexById = new Map<string, number>();
  notes.forEach((note, i) => {
    const first = firstIndexById.get(note.id);
    if (first !== undefined) throw new Error(`Note ${i + 1} has the same id as note ${first + 1}.`);
    firstIndexById.set(note.id, i);
  });

  return {
    format: 'webmark',
    version: BUNDLE_VERSION,
    exportedAt: finiteNumber.test(data.exportedAt) ? data.exportedAt : 0,
    notes,
    screenshots: parseScreenshots(data.screenshots, new Set(firstIndexById.keys())),
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * hasScreenshot must match what will actually be stored. A note exported
 * without its screenshot keeps the flag only when merging over a local copy
 * that still has one, so a merge never hides a screenshot the user already has.
 */
async function withScreenshotFlag(note: Note, screenshots: Record<string, string>, keepLocal: boolean): Promise<Note> {
  if (screenshots[note.id]) return note.hasScreenshot ? note : { ...note, hasScreenshot: true };
  if (!note.hasScreenshot) return note;
  const local = keepLocal ? await getScreenshot(note.id) : undefined;
  return local ? note : { ...note, hasScreenshot: false };
}

/** 'merge' keeps existing notes (newer copy wins); 'replace' deletes everything first. */
export async function importBundle(bundle: ExportBundle, mode: 'merge' | 'replace'): Promise<ImportSummary> {
  if (mode === 'replace') await deleteAllNotes();
  const notes = await Promise.all(
    bundle.notes.map((note) => withScreenshotFlag(note, bundle.screenshots, mode === 'merge')),
  );
  return bulkPutNotes(notes, bundle.screenshots);
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/** Firefox cancels a download whose blob URL is revoked in the same task as the click. */
const REVOKE_DELAY_MS = 10_000;

/** Trigger a file download from an extension page. */
export function downloadFile(filename: string, contents: string, mimeType: string): void {
  // Excel only detects UTF-8 in a CSV when it starts with a byte-order mark.
  const parts = mimeType.startsWith('text/csv') ? ['﻿', contents] : [contents];
  const url = URL.createObjectURL(new Blob(parts, { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}
