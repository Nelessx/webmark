import { isNotePriority, isNoteStatus } from '../noteMeta';
import type { DraftState, EditorFields, EditorFrameEvent, EditorPage, EditorRequest } from './protocol';

/*
 * Shape checks for what the background accepts from content scripts and
 * editor frames. Every sender is WebMark's own code, but a content script
 * shares a process with the web page, so nothing is taken on trust.
 */

const MAX_TEXT = 100_000;
const MAX_SCREENSHOT = 20_000_000;
const MAX_HEIGHT = 10_000;
const MAX_TOAST = 200;

type Check = (value: unknown) => boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isText = (value: unknown, max = MAX_TEXT): value is string => typeof value === 'string' && value.length <= max;
const isOptional = (check: Check) => (value: unknown) => value === undefined || check(value);
const isStatus: Check = isNoteStatus;
const isPriority: Check = isNotePriority;
const isId: Check = (value) => isText(value, 200) && value !== '';
const isScreenshot: Check = (value) =>
  isText(value, MAX_SCREENSHOT) && /^data:image\/(png|jpe?g|webp);base64,/i.test(value);

function hasFields(value: unknown, fields: Readonly<Record<string, Check>>): value is Record<string, unknown> {
  return isRecord(value) && Object.entries(fields).every(([key, check]) => check(value[key]));
}

export function isEditorFields(value: unknown): value is EditorFields {
  return hasFields(value, { label: isText, body: isText, tags: isText, status: isStatus, priority: isPriority });
}

export function isDraftState(value: unknown): value is DraftState {
  return hasFields(value, { initial: isEditorFields, values: isEditorFields });
}

function isPage(value: unknown): value is EditorPage {
  return hasFields(value, { pageKey: (v) => isText(v) && v !== '', url: isText, title: isText });
}

export function isEditorRequest(value: unknown): value is EditorRequest {
  const base = { page: isPage, label: isText, draft: isOptional(isDraftState) };
  if (!isRecord(value)) return false;
  if (value.mode === 'create') return hasFields(value, { ...base, anchor: isRecord, screenshot: isOptional(isScreenshot) });
  if (value.mode === 'edit') return hasFields(value, { ...base, noteId: isId });
  return false;
}

export function isEditorFrameEvent(value: unknown): value is EditorFrameEvent {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'height':
      return typeof value.height === 'number' && Number.isFinite(value.height) && value.height >= 0 && value.height <= MAX_HEIGHT;
    case 'dirty':
      return typeof value.dirty === 'boolean';
    case 'saved':
      return hasFields(value.note, { id: isId, pageKey: isText, anchor: isRecord });
    case 'deleted':
      return isId(value.noteId);
    case 'deleting':
    case 'closed':
      return true;
    case 'toast':
      return isText(value.text, MAX_TOAST) && (value.tone === 'info' || value.tone === 'error');
    default:
      return false;
  }
}
