import { isArchivableStatus, isNotePriority, isNoteStatus } from './noteMeta';
import { isScreenshotDataUrl } from './screenshotDb';
import type { StorageOp } from './storage';
import type { NotePatch, Settings } from './types';

/*
 * Checks on the write requests other contexts send to the storage writer (the
 * background). Every sender is WebMark's own code, but content scripts share
 * a process with the web page, so each request's operation and argument
 * shapes are verified before anything touches storage (defence in depth).
 *
 * Notes are checked field by field but passed on as they are, so fields added
 * to the Note type later survive the trip.
 */

export const STORAGE_REQUEST = 'wm:storage';

export interface StorageRequest {
  type: typeof STORAGE_REQUEST;
  op: StorageOp;
  args: unknown[];
}

type Check = (value: unknown) => boolean;

interface OpSpec {
  /** Bulk and destructive operations: extension pages only, never a content script. */
  pagesOnly: boolean;
  /** Argument checks, in order; trailing optional arguments may be missing. */
  args: Check[];
  required: number;
}

const MAX_ID_LENGTH = 200;
const MAX_BATCH = 10_000;
const MAX_SETTING_TEXT = 1_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText: Check = (value) => typeof value === 'string';
const isBoolean: Check = (value) => typeof value === 'boolean';
const isNumber: Check = (value) => typeof value === 'number' && Number.isFinite(value);
const isNoteId: Check = (value) => typeof value === 'string' && value !== '' && value.length <= MAX_ID_LENGTH;
const isPageKey: Check = (value) => typeof value === 'string' && value !== '';
const isTextList: Check = (value) => Array.isArray(value) && value.every(isText);
const isStatus: Check = isNoteStatus;
const isPriority: Check = isNotePriority;
const listOf = (check: Check, max = MAX_BATCH): Check => (value) =>
  Array.isArray(value) && value.length <= max && value.every(check);

function hasFields(value: unknown, fields: Readonly<Record<string, Check>>): boolean {
  return isRecord(value) && Object.entries(fields).every(([key, check]) => check(value[key]));
}

const NOTE_FIELDS: Record<string, Check> = {
  id: isNoteId,
  schemaVersion: isNumber,
  pageKey: isPageKey,
  url: isText,
  pageTitle: isText,
  label: isText,
  body: isText,
  status: isStatus,
  archivedFrom: (value) => value === undefined || isArchivableStatus(value),
  priority: isPriority,
  tags: isTextList,
  author: isText,
  anchor: isRecord,
  hasScreenshot: isBoolean,
  createdAt: isNumber,
  updatedAt: isNumber,
};

/** The fields updateNote() may change; anything else (id, pageKey, timestamps) is refused. */
const PATCH_FIELDS: Record<keyof NotePatch, Check> = {
  label: isText,
  body: isText,
  status: isStatus,
  priority: isPriority,
  tags: isTextList,
  anchor: isRecord,
  hasScreenshot: isBoolean,
};

const SETTINGS_FIELDS: Record<keyof Settings, Check> = {
  pinsVisible: isBoolean,
  captureScreenshots: isBoolean,
  authorName: (value) => typeof value === 'string' && value.length <= MAX_SETTING_TEXT,
};

/** Settings added later: plain values only. */
const isSettingValue: Check = (value) =>
  isBoolean(value) || isNumber(value) || (typeof value === 'string' && value.length <= MAX_SETTING_TEXT);

const isNote: Check = (value) => hasFields(value, NOTE_FIELDS);

const isPatch: Check = (value) =>
  isRecord(value) &&
  Object.entries(value).every(
    ([key, field]) => Object.hasOwn(PATCH_FIELDS, key) && (field === undefined || PATCH_FIELDS[key as keyof NotePatch](field)),
  );

const isSettingsPatch: Check = (value) =>
  isRecord(value) &&
  Object.entries(value).every(([key, field]) => {
    if (field === undefined) return true;
    if (Object.hasOwn(SETTINGS_FIELDS, key)) return SETTINGS_FIELDS[key as keyof Settings](field);
    return /^[A-Za-z]\w{0,49}$/.test(key) && isSettingValue(field);
  });

const isNoteRef: Check = (value) => hasFields(value, { pageKey: isPageKey, noteId: isNoteId });
const isNoteUpdate: Check = (value) => hasFields(value, { pageKey: isPageKey, noteId: isNoteId, patch: isPatch });
const isScreenshotMap: Check = (value) =>
  isRecord(value) && Object.entries(value).every(([id, dataUrl]) => isNoteId(id) && isScreenshotDataUrl(dataUrl));

const op = (pagesOnly: boolean, args: Check[], required = args.length): OpSpec => ({ pagesOnly, args, required });

const OPS: Record<StorageOp, OpSpec> = {
  saveNote: op(false, [isNote]),
  updateNote: op(false, [isPageKey, isNoteId, isPatch]),
  updateNotes: op(true, [listOf(isNoteUpdate)]),
  deleteNote: op(false, [isPageKey, isNoteId]),
  deleteNotes: op(true, [listOf(isNoteRef)]),
  bulkPutNotes: op(true, [listOf(isNote), isScreenshotMap], 1),
  deleteAllNotes: op(true, []),
  saveScreenshot: op(false, [isNoteId, isScreenshotDataUrl]),
  getScreenshot: op(false, [isNoteId]),
  getScreenshots: op(true, [listOf(isNoteId, 100)]),
  saveSettings: op(false, [isSettingsPatch]),
  setPendingFocus: op(true, [isPageKey, isNoteId]),
  takePendingFocus: op(false, [isPageKey]),
};

export function isStorageRequest(value: unknown): value is StorageRequest {
  return isRecord(value) && value.type === STORAGE_REQUEST;
}

/**
 * The operation and arguments of a request, or an Error saying why it is
 * refused. `fromExtensionPage`: sent by an extension page rather than a
 * content script.
 */
export function checkStorageRequest(request: StorageRequest, fromExtensionPage: boolean): { op: StorageOp; args: unknown[] } {
  const name = request.op as unknown;
  if (typeof name !== 'string' || !Object.hasOwn(OPS, name)) throw new Error('Unknown storage operation');
  const spec = OPS[name as StorageOp];
  if (spec.pagesOnly && !fromExtensionPage) throw new Error(`'${name}' is only available to WebMark's own pages`);
  const args = request.args as unknown;
  if (!Array.isArray(args) || args.length < spec.required || args.length > spec.args.length) {
    throw new Error(`Wrong number of arguments for '${name}'`);
  }
  args.forEach((arg, i) => {
    const optional = i >= spec.required && arg === undefined;
    if (!optional && !spec.args[i]?.(arg)) throw new Error(`Invalid argument ${i + 1} for '${name}'`);
  });
  return { op: name as StorageOp, args };
}
