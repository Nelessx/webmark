// CONTRACT STUB — implemented by the data module owner. Signatures are fixed.
import type { Note } from './types';

/** One note as Markdown, ready to paste into a GitHub/Jira/Trello issue. */
export function noteToMarkdown(note: Note, options?: { includeTechnical?: boolean }): string {
  throw new Error('not implemented');
}

/** A full Markdown report of many notes, grouped by site and page. */
export function notesToMarkdownReport(notes: Note[], options?: { title?: string }): string {
  throw new Error('not implemented');
}

/** CSV export (one row per note), RFC 4180 quoting. */
export function notesToCsv(notes: Note[]): string {
  throw new Error('not implemented');
}

/** "just now", "5 min ago", "yesterday", "3 Mar 2026" … */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  throw new Error('not implemented');
}

/** Parse "bug, ui,  Urgent" → ["bug", "ui", "urgent"] (trimmed, lower-cased, de-duplicated). */
export function parseTags(input: string): string[] {
  throw new Error('not implemented');
}
