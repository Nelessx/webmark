import { pinNumber } from './constants';
import { NOTE_PRIORITIES, NOTE_STATUSES, PRIORITY_LABELS, STATUS_LABELS } from './noteMeta';
import type { Note, NotePriority, NoteStatus } from './types';
import { displayPageKey, redactUrl, sanitizePageKey, siteOf } from './url';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Largest timestamp a Date can hold; beyond it toISOString() and Intl throw. */
const MAX_DATE_MS = 8.64e15;

function isValidTimestamp(ts: number): boolean {
  return Number.isFinite(ts) && Math.abs(ts) <= MAX_DATE_MS;
}

function toIso(ts: number): string {
  return isValidTimestamp(ts) ? new Date(ts).toISOString() : '';
}

/** "2026-03-03 14:05 UTC" — UTC so a shared report reads the same in every time zone. */
function formatUtcDateTime(ts: number): string {
  const iso = toIso(ts);
  return iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'unknown date';
}

/** Local files have no host, so group them under one friendly name instead of one "site" per path. */
function siteLabel(pageKey: string): string {
  return pageKey.startsWith('file:') ? 'Local files' : siteOf(pageKey);
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Markdown building blocks
// ---------------------------------------------------------------------------

const HEADING_SNIPPET_MAX = 80;

/**
 * Escape short user/page text (labels, titles, tags) placed inline in
 * Markdown, so it can't create links, emphasis, HTML, heading closers or
 * entities. Also flattens it to one line so it can't start new blocks.
 */
function escapeInline(text: string): string {
  return oneLine(text)
    .replace(/[\\`*_[\]<>#~|]/g, '\\$&')
    .replace(/&(?=#?[a-z0-9]+;)/gi, '\\&');
}

/** Inline code span whose delimiter is longer than any backtick run inside it. */
function codeSpan(text: string): string {
  const content = text.replace(/[\r\n]+/g, ' ');
  if (!content.trim()) return '_(none)_';
  const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  const pad = content.startsWith('`') || content.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${content}${pad}${fence}`;
}

/**
 * Exported text never carries credentials: tokens in saved URLs are redacted,
 * and page keys (notes saved by older versions may still have them) lose them.
 */
function exportPageKey(pageKey: string): string {
  return displayPageKey(sanitizePageKey(pageKey));
}

/** Only link real web/file pages; anything else (javascript:, data:…) is shown as code. */
function safeLinkTarget(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (!['http:', 'https:', 'file:'].includes(u.protocol)) return undefined;
    // Parens are legal in URLs but would end a Markdown link destination early.
    return u.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
  } catch {
    return undefined;
  }
}

function pageLink(title: string, savedUrl: string, pageKey: string): string {
  const url = redactUrl(savedUrl);
  const text = escapeInline(title) || escapeInline(exportPageKey(pageKey)) || 'Untitled page';
  const target = safeLinkTarget(url);
  return target ? `[${text}](${target})` : `${text} (${codeSpan(url)})`;
}

interface Fence {
  char: string;
  length: number;
}

function fenceOpening(line: string): Fence | undefined {
  const run = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
  if (!run) return undefined;
  // CommonMark: a backtick fence's info string can't contain backticks.
  if (run.startsWith('`') && line.slice(line.indexOf(run) + run.length).includes('`')) return undefined;
  return { char: run.charAt(0), length: run.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const run = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
  return !!run && run.startsWith(fence.char) && run.length >= fence.length;
}

/**
 * The note body as Markdown lines. Bodies stay readable (no blanket escaping),
 * but anything that could swallow the rest of the document is neutralised:
 * raw HTML/comments are escaped and an unclosed code fence is closed.
 * Line breaks become hard breaks so the text reads as typed.
 */
function markdownBodyLines(body: string): string[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[0]?.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop();

  const out: string[] = [];
  let fence: Fence | undefined;
  lines.forEach((line, i) => {
    if (fence) {
      out.push(line);
      if (closesFence(line, fence)) fence = undefined;
      return;
    }
    fence = fenceOpening(line);
    if (fence) {
      out.push(line);
      return;
    }
    const text = line.trimEnd().replace(/<(?=[a-z/!?])/gi, '\\<');
    const next = lines[i + 1];
    const hardBreak = text.trim() !== '' && !!next?.trim() && !fenceOpening(next);
    out.push(hardBreak ? `${text}  ` : text);
  });
  if (fence) out.push(fence.char.repeat(fence.length));
  return out;
}

function firstLine(body: string): string {
  return body.split(/\r\n|\r|\n/).map(oneLine).find(Boolean) ?? '';
}

function statusLabel(note: Note): string {
  return STATUS_LABELS[note.status];
}

function priorityLabel(note: Note): string {
  return PRIORITY_LABELS[note.priority];
}

/** Work that is finished or put away is ticked in a report's checklist. */
function isDone(note: Note): boolean {
  return note.status === 'completed' || note.status === 'archived';
}

function tagList(tags: string[]): string {
  return tags.map(escapeInline).filter(Boolean).join(', ');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** One note as Markdown, ready to paste into a GitHub/Jira/Trello issue. */
export function noteToMarkdown(note: Note, options?: { includeTechnical?: boolean }): string {
  const includeTechnical = options?.includeTechnical ?? true;
  const label = escapeInline(note.label) || 'Element';
  const summary = escapeInline(truncate(firstLine(note.body), HEADING_SNIPPET_MAX));
  const lines = [`### [${label}]${summary ? ` ${summary}` : ''}`, ''];

  const body = markdownBodyLines(note.body);
  if (body.length) lines.push(...body, '');

  lines.push(`- **Page:** ${pageLink(note.pageTitle, note.url, note.pageKey)}`);
  lines.push(`- **Status:** ${statusLabel(note)}`);
  lines.push(`- **Priority:** ${priorityLabel(note)}`);
  const tags = tagList(note.tags);
  if (tags) lines.push(`- **Tags:** ${tags}`);
  const author = escapeInline(note.author);
  if (author) lines.push(`- **Author:** ${author}`);
  lines.push(`- **Created:** ${formatUtcDateTime(note.createdAt)}`);

  if (includeTechnical) {
    lines.push(
      '',
      '<details>',
      '<summary>Technical details</summary>',
      '',
      `- **Selector:** ${codeSpan(note.anchor.selector)}`,
      `- **XPath:** ${codeSpan(note.anchor.xpath)}`,
      '',
      '</details>',
    );
  }
  return `${lines.join('\n')}\n`;
}

interface PageGroup {
  pageKey: string;
  /** Oldest first. */
  notes: Note[];
  /** Pin number of each note, counted over all of the page's notes (see notesToMarkdownReport). */
  pins: Map<string, number>;
}

/**
 * Pin numbers as the page shows them: counted over every note of each page,
 * including ones a report leaves out (archived notes still hold their number).
 */
function pinNumbersByPage(allNotes: Note[]): Map<string, number> {
  const byPage = new Map<string, Note[]>();
  for (const note of allNotes) byPage.set(note.pageKey, [...(byPage.get(note.pageKey) ?? []), note]);
  const pins = new Map<string, number>();
  for (const pageNotes of byPage.values()) {
    const ordered = [...pageNotes].sort((a, b) => a.createdAt - b.createdAt);
    for (const note of ordered) pins.set(note.id, pinNumber(note.id, ordered));
  }
  return pins;
}

function groupBySiteAndPage(notes: Note[], allNotes: Note[]): Map<string, PageGroup[]> {
  const pins = pinNumbersByPage(allNotes);
  const pages = new Map<string, Note[]>();
  for (const note of notes) {
    const list = pages.get(note.pageKey) ?? [];
    list.push(note);
    pages.set(note.pageKey, list);
  }

  const sites = new Map<string, PageGroup[]>();
  const pageKeys = [...pages.keys()].sort(compareText);
  for (const pageKey of pageKeys) {
    const site = siteLabel(pageKey);
    const group: PageGroup = {
      pageKey,
      notes: [...(pages.get(pageKey) ?? [])].sort((a, b) => a.createdAt - b.createdAt),
      pins,
    };
    sites.set(site, [...(sites.get(site) ?? []), group]);
  }
  return new Map([...sites].sort(([a], [b]) => compareText(a, b)));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function reportPageLines(group: PageGroup): string[] {
  // The newest note carries the page's most recent title and URL.
  const newest = [...group.notes].reverse();
  const title = newest.find((n) => n.pageTitle.trim())?.pageTitle ?? '';
  const url = redactUrl(newest[0]?.url ?? sanitizePageKey(group.pageKey));
  const heading = escapeInline(title) || escapeInline(exportPageKey(group.pageKey)) || 'Untitled page';
  const target = safeLinkTarget(url);

  const lines = [`### ${heading}`, '', target ? `<${target}>` : codeSpan(url), ''];
  for (const note of group.notes) {
    lines.push(...reportNoteLines(note, group.pins.get(note.id) ?? pinNumber(note.id, group.notes)), '');
  }
  return lines;
}

function reportNoteLines(note: Note, pin: number): string[] {
  const box = isDone(note) ? '[x]' : '[ ]';
  const label = escapeInline(note.label) || 'Element';
  const lines = [`- ${box} **#${pin} · ${label}** · ${statusLabel(note)} · ${priorityLabel(note)} priority`];

  const indent = (line: string) => (line ? `  ${line}` : '');
  const body = markdownBodyLines(note.body);
  if (body.length) lines.push('', ...body.map(indent));

  const tags = tagList(note.tags);
  const author = escapeInline(note.author);
  const meta = [tags && `Tags: ${tags}`, author && `By ${author}`, formatUtcDateTime(note.createdAt)].filter(Boolean);
  lines.push('', indent(`_${meta.join(' · ')}_`));
  return lines;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function countBy<K extends string>(notes: Note[], keys: readonly K[], key: (note: Note) => K): Map<K, number> {
  const counts = new Map<K, number>(keys.map((k) => [k, 0]));
  for (const note of notes) counts.set(key(note), (counts.get(key(note)) ?? 0) + 1);
  return counts;
}

/**
 * "4 open · 2 in progress · 5 completed" and "3 high · 6 medium · 2 low priority":
 * every status/priority in workflow order, leaving out ones no note has.
 */
function summaryLines(notes: Note[]): string[] {
  const byStatus = countBy<NoteStatus>(notes, NOTE_STATUSES, (n) => n.status);
  const byPriority = countBy<NotePriority>(notes, NOTE_PRIORITIES, (n) => n.priority);
  const statuses = NOTE_STATUSES.filter((s) => byStatus.get(s))
    .map((s) => `${byStatus.get(s)} ${STATUS_LABELS[s].toLowerCase()}`)
    .join(' · ');
  const priorities = NOTE_PRIORITIES.filter((p) => byPriority.get(p))
    .map((p) => `${byPriority.get(p)} ${PRIORITY_LABELS[p].toLowerCase()}`)
    .join(' · ');
  const lines = [`**${plural(notes.length, 'note')}**${statuses ? ` · ${statuses}` : ''}`];
  if (priorities) lines.push('', `Priority: ${priorities}`);
  return lines;
}

/**
 * A full Markdown report of many notes, grouped by site and page.
 * `allNotes`: every note of the pages involved, including ones left out of the
 * report (e.g. archived), so "#3" is the same note as pin 3 on the page.
 * Defaults to `notes`.
 */
export function notesToMarkdownReport(notes: Note[], options?: { title?: string; allNotes?: Note[] }): string {
  const title = escapeInline(options?.title ?? '') || 'WebMark feedback report';
  const lines = [`# ${title}`, '', `Generated ${formatUtcDateTime(Date.now())}`, '', ...summaryLines(notes), ''];

  if (!notes.length) {
    lines.push('_No notes._', '');
  }
  for (const [site, groups] of groupBySiteAndPage(notes, options?.allNotes ?? notes)) {
    lines.push(`## ${escapeInline(site)}`, '');
    for (const group of groups) lines.push(...reportPageLines(group));
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const CSV_COLUMNS = [
  'id',
  'site',
  'page_title',
  'url',
  'label',
  'body',
  'status',
  'priority',
  'tags',
  'author',
  'created_at',
  'updated_at',
  'selector',
] as const;

/**
 * RFC 4180 cell. Cells that a spreadsheet would treat as a formula get a
 * leading apostrophe, so a malicious note can't run `=HYPERLINK(...)` etc.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function csvRow(note: Note): string[] {
  return [
    note.id,
    siteLabel(note.pageKey),
    note.pageTitle,
    redactUrl(note.url),
    note.label,
    note.body,
    // Labels, not codes: CSV exports are read in spreadsheets.
    statusLabel(note),
    priorityLabel(note),
    note.tags.join('; '),
    note.author,
    toIso(note.createdAt),
    toIso(note.updatedAt),
    note.anchor.selector,
  ];
}

/** CSV export (one row per note), RFC 4180 quoting. */
export function notesToCsv(notes: Note[]): string {
  const rows = [[...CSV_COLUMNS], ...notes.map(csvRow)];
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// Relative time
// ---------------------------------------------------------------------------

let dateWithYear: Intl.DateTimeFormat | undefined;
let dateWithoutYear: Intl.DateTimeFormat | undefined;

function shortDate(ts: number, now: number): string {
  const sameYear = isValidTimestamp(now) && new Date(ts).getFullYear() === new Date(now).getFullYear();
  if (sameYear) {
    dateWithoutYear ??= new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
    return dateWithoutYear.format(ts);
  }
  dateWithYear ??= new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return dateWithYear.format(ts);
}

/** "just now", "5 min ago", "yesterday", "3 Mar 2026" … */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  if (!isValidTimestamp(timestamp)) return '';
  const elapsed = now - timestamp;
  // Small negative values are clock skew between contexts; larger ones are real future dates.
  if (elapsed < -MINUTE || Number.isNaN(elapsed)) return shortDate(timestamp, now);
  if (elapsed < 45_000) return 'just now';
  if (elapsed < HOUR) return `${Math.max(1, Math.floor(elapsed / MINUTE))} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  const days = Math.floor(elapsed / DAY);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return shortDate(timestamp, now);
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 32;

function normaliseTag(raw: string): string {
  const tag = raw.trim().replace(/^#+/, '').trim().toLowerCase().replace(/\s+/g, '-');
  return Array.from(tag).slice(0, MAX_TAG_LENGTH).join('').replace(/^-+|-+$/g, '');
}

/** Parse "bug, ui,  Urgent" → ["bug", "ui", "urgent"] (trimmed, lower-cased, de-duplicated). */
export function parseTags(input: string): string[] {
  const tags: string[] = [];
  // Commas (and semicolons, as written by the CSV export) separate tags; so
  // does whitespace in front of a "#hashtag", which allows "#bug #ui".
  for (const segment of input.split(/[,;\n]/)) {
    for (const raw of segment.split(/\s+(?=#)/)) {
      const tag = normaliseTag(raw);
      if (tag && !tags.includes(tag)) tags.push(tag);
      if (tags.length === MAX_TAGS) return tags;
    }
  }
  return tags;
}
