import { TEST_ID_ATTRIBUTES } from './anchor/stability';
import { NOTE_LIMITS as LIMIT } from './limits';
import { isScreenshotDataUrl } from './screenshotDb';
import { bulkPutNotes, deleteAllNotes, getAllNotes, getScreenshots } from './storage';
import { NOTE_SCHEMA_VERSION, type AnchorItem, type DocRect, type ElementAnchor, type Note, type NoteStatus } from './types';
import { getPageKey, isPageUrl, redactUrl, sanitizePageKey } from './url';

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

/** A note as it may leave the browser: no credentials in its URL or page key. */
function forExport(note: Note): Note {
  const url = redactUrl(note.url);
  const pageKey = sanitizePageKey(note.pageKey);
  return url === note.url && pageKey === note.pageKey ? note : { ...note, url, pageKey };
}

/** Collect notes (all, or the given subset) and optionally their screenshots. */
export async function buildExportBundle(options?: { includeScreenshots?: boolean; notes?: Note[] }): Promise<ExportBundle> {
  const notes = options?.notes ?? (await getAllNotes());
  const withShots = options?.includeScreenshots ?? true;
  const screenshots = withShots ? await getScreenshots(notes.filter((n) => n.hasScreenshot).map((n) => n.id)) : {};
  return { format: 'webmark', version: BUNDLE_VERSION, exportedAt: Date.now(), notes: notes.map(forExport), screenshots };
}

// ---------------------------------------------------------------------------
// Validation. An import file is untrusted input: every value is checked and
// copied into a fresh object, so unknown or malformed data never reaches
// storage. Lengths are capped (see limits.ts), links must be web or file
// pages, and the page key must belong to the note's URL, so a shared file
// can't show one site on a card while "Open on page" opens another.
// Selectors and XPaths are limited to the shapes WebMark generates, since the
// page evaluates them on every visit.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

interface Check<T> {
  test: (value: unknown) => value is T;
  /** What a valid value looks like, phrased for the value that failed. */
  expected: (value: unknown) => string;
}

/** Where a field lives, for error messages like "Note 3 is missing 'anchor.selector'". */
interface Ctx {
  owner: string;
  path: string;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isStringMap = (value: unknown): value is Json => isRecord(value) && Object.values(value).every(isString);
const characters = (max: number) => `at most ${max} characters`;

function text(max: number): Check<string> {
  return {
    test: (v): v is string => isString(v) && v.length <= max,
    expected: (v) => (isString(v) ? characters(max) : 'text'),
  };
}

function nonEmptyText(max: number): Check<string> {
  return {
    test: (v): v is string => isString(v) && v.trim() !== '' && v.length <= max,
    expected: (v) => (isString(v) && v.trim() !== '' ? characters(max) : 'non-empty text'),
  };
}

function textList(maxItems: number, maxLength: number): Check<string[]> {
  return {
    test: (v): v is string[] => isStringList(v) && v.length <= maxItems && v.every((item) => item.length <= maxLength),
    expected: (v) => {
      if (!isStringList(v)) return 'a list of text';
      return v.length > maxItems ? `at most ${maxItems} items` : `items of ${characters(maxLength)}`;
    },
  };
}

function textMap(maxEntries: number, maxKey: number, maxValue: number): Check<Json> {
  return {
    test: (v): v is Json => {
      if (!isStringMap(v)) return false;
      const entries = Object.entries(v);
      return entries.length <= maxEntries && entries.every(([key, item]) => key.length <= maxKey && (item as string).length <= maxValue);
    },
    expected: (v) => {
      if (!isStringMap(v)) return 'an object of text values';
      if (Object.keys(v).length > maxEntries) return `at most ${maxEntries} entries`;
      return `names of ${characters(maxKey)} and values of ${characters(maxValue)}`;
    },
  };
}

/** A check that only asks for a value of the right type. */
function simple<T>(test: (value: unknown) => value is T, expected: string): Check<T> {
  return { test, expected: () => expected };
}

const finiteNumber = simple((v): v is number => typeof v === 'number' && Number.isFinite(v), 'a number');
const boolean = simple((v): v is boolean => typeof v === 'boolean', 'true or false');
const object = simple(isRecord, 'an object');
const status = simple((v): v is NoteStatus => v === 'open' || v === 'resolved', "'open' or 'resolved'");
const count = simple((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0, 'a whole number of 0 or more');
const testIdName = simple(
  (v): v is string => typeof v === 'string' && (TEST_ID_ATTRIBUTES as readonly string[]).includes(v),
  `one of ${TEST_ID_ATTRIBUTES.join(', ')}`,
);

/** Text, within `max` characters, that also passes `valid`; `shape` describes a valid value. */
function shapedText(max: number, valid: (value: string) => boolean, shape: string): Check<string> {
  return {
    test: (v): v is string => isString(v) && v.length <= max && valid(v),
    expected: (v) => (!isString(v) ? 'text' : v.length > max ? characters(max) : shape),
  };
}

const pageUrl = shapedText(LIMIT.url, isPageUrl, 'an http, https or file address');

/**
 * One step of the XPaths anchor/xpath.ts builds: an element name (or "*" for
 * SVG/MathML) with an optional 1-based position, e.g. "div[2]". Nothing else:
 * no axes, functions or other predicates.
 */
const XPATH_STEP = /^(?:\*|[\p{L}_][\p{L}\p{N}_.\-·]*)(?:\[[1-9]\d{0,5}\])?$/u;

const generatedXPath = shapedText(
  LIMIT.xpath,
  (v) => v.startsWith('/') && v.slice(1).split('/').every((step) => XPATH_STEP.test(step)),
  'an absolute XPath like /html/body/div[2]',
);

/**
 * Selectors as anchor/selector.ts builds them: tags, #ids, .classes,
 * [attr="value"] and :nth-of-type(n), joined by " " or " > ". Quoted values
 * and escaped characters are set aside first; anything left beyond that
 * (selector lists, "*", sibling combinators, :has() / :not() and other
 * pseudo-classes, attribute operators other than "=") is refused.
 */
function isGeneratedSelector(value: string): boolean {
  const bare = value
    .replace(/"(?:[^"\\\n]|\\[\s\S])*"/g, '""')
    .replace(/\\(?:[0-9a-f]{1,6}[ \t\n]?|[^\n0-9a-f])/gi, 'x')
    .replace(/:nth-of-type\(\d{1,6}\)/g, '');
  return /^[\w\-#.[\]="> \u0080-\u{10FFFF}]*$/u.test(bare);
}

const generatedSelector = shapedText(LIMIT.selector, isGeneratedSelector, 'a CSS selector like WebMark creates');

/** A present value must pass the check; absent (undefined/null) returns undefined. */
function optional<T>(obj: Json, key: string, check: Check<T>, ctx: Ctx): T | undefined {
  const value = Object.hasOwn(obj, key) ? obj[key] : undefined;
  if (value === undefined || value === null) return undefined;
  if (!check.test(value)) {
    throw new Error(`${ctx.owner} has an invalid '${ctx.path}${key}' (expected ${check.expected(value)}).`);
  }
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

/** The look-alike context of an anchor (see AnchorItem); absent on older anchors. */
function parseItem(raw: Json | undefined, ctx: Ctx): AnchorItem | undefined {
  if (!raw) return undefined;
  const item: AnchorItem = {
    depth: required(raw, 'depth', count, ctx),
    text: required(raw, 'text', text(LIMIT.text), ctx),
    length: required(raw, 'length', count, ctx),
    shapeUnique: required(raw, 'shapeUnique', boolean, ctx),
  };
  const testId = optional(raw, 'testId', object, ctx);
  if (testId) {
    const idCtx = nested(ctx, 'testId');
    item.testId = { name: required(testId, 'name', testIdName, idCtx), value: required(testId, 'value', text(LIMIT.attributeValue), idCtx) };
  }
  return item;
}

function parseAnchor(raw: Json, ctx: Ctx): ElementAnchor {
  const attributes = optional(raw, 'attributes', textMap(LIMIT.attributes, LIMIT.attributeName, LIMIT.attributeValue), ctx);
  const anchor: ElementAnchor = {
    selector: required(raw, 'selector', generatedSelector, ctx),
    xpath: required(raw, 'xpath', generatedXPath, ctx),
    tagName: required(raw, 'tagName', text(LIMIT.tagName), ctx),
    classes: [...(optional(raw, 'classes', textList(LIMIT.classes, LIMIT.className), ctx) ?? [])],
    // fromEntries defines own properties, so a "__proto__" key stays plain data.
    attributes: Object.fromEntries(Object.entries(attributes ?? {})) as Record<string, string>,
    text: optional(raw, 'text', text(LIMIT.text), ctx) ?? '',
    rect: parseRect(optional(raw, 'rect', object, ctx), nested(ctx, 'rect')),
    viewport: parseViewport(optional(raw, 'viewport', object, ctx), nested(ctx, 'viewport')),
    ancestorTags: [...(optional(raw, 'ancestorTags', textList(LIMIT.ancestors, LIMIT.tagName), ctx) ?? [])],
    nthOfType: optional(raw, 'nthOfType', finiteNumber, ctx) ?? 1,
  };
  const id = optional(raw, 'id', text(LIMIT.elementId), ctx);
  if (id) anchor.id = id;
  // Look-alike data (added later): keep it, or restored notes fall back to the
  // weaker rules for old anchors and notes on repeated controls get orphaned.
  const lookAlikes = optional(raw, 'lookAlikes', count, ctx);
  if (lookAlikes !== undefined) anchor.lookAlikes = lookAlikes;
  const shapeUnique = optional(raw, 'shapeUnique', boolean, ctx);
  if (shapeUnique !== undefined) anchor.shapeUnique = shapeUnique;
  const uniqueHooks = optional(raw, 'uniqueHooks', textList(LIMIT.attributes, LIMIT.attributeName), ctx);
  if (uniqueHooks) anchor.uniqueHooks = [...uniqueHooks];
  const item = parseItem(optional(raw, 'item', object, ctx), nested(ctx, 'item'));
  if (item) anchor.item = item;
  return anchor;
}

/** The page key is always derived from the URL; the file's own must name the same page. */
function parsePageKey(raw: Json, url: string, ctx: Ctx): string {
  const stated = required(raw, 'pageKey', nonEmptyText(LIMIT.url), ctx);
  const pageKey = getPageKey(url);
  // getPageKey(stated) also accepts keys from before credentials were dropped from page keys.
  if (stated !== pageKey && getPageKey(stated) !== pageKey) {
    throw new Error(`${ctx.owner} has a 'pageKey' that does not match its 'url'.`);
  }
  return pageKey;
}

function parseNote(raw: unknown, index: number): Note {
  const ctx: Ctx = { owner: `Note ${index + 1}`, path: '' };
  if (!isRecord(raw)) throw new Error(`${ctx.owner} is not a valid note.`);
  const id = required(raw, 'id', nonEmptyText(LIMIT.id), ctx);
  const url = required(raw, 'url', pageUrl, ctx);
  return {
    id,
    schemaVersion: NOTE_SCHEMA_VERSION,
    pageKey: parsePageKey(raw, url, ctx),
    url,
    pageTitle: required(raw, 'pageTitle', text(LIMIT.pageTitle), ctx),
    label: required(raw, 'label', text(LIMIT.label), ctx),
    body: required(raw, 'body', text(LIMIT.body), ctx),
    status: required(raw, 'status', status, ctx),
    tags: [...required(raw, 'tags', textList(LIMIT.tags, LIMIT.tag), ctx)],
    author: optional(raw, 'author', text(LIMIT.author), ctx) ?? '',
    anchor: parseAnchor(required(raw, 'anchor', object, ctx), nested(ctx, 'anchor')),
    hasScreenshot: optional(raw, 'hasScreenshot', boolean, ctx) ?? false,
    createdAt: required(raw, 'createdAt', finiteNumber, ctx),
    updatedAt: required(raw, 'updatedAt', finiteNumber, ctx),
  };
}

function parseScreenshots(raw: unknown, noteIds: Set<string>): Record<string, string> {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(([id, value]) => noteIds.has(id) && isScreenshotDataUrl(value)),
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
 * 'merge' keeps existing notes (newer copy wins); 'replace' deletes everything
 * first. Storage keeps each note's hasScreenshot true only when a screenshot
 * is really stored for it: from the file, or (merging) the one already here.
 */
export async function importBundle(bundle: ExportBundle, mode: 'merge' | 'replace'): Promise<ImportSummary> {
  if (mode === 'replace') await deleteAllNotes();
  return bulkPutNotes(bundle.notes, bundle.screenshots);
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
