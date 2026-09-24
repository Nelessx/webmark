// CONTRACT STUB — implemented by the data module owner. Signatures are fixed.
import type { Note } from './types';

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

/** Collect notes (all, or the given subset) and optionally their screenshots. */
export async function buildExportBundle(options?: { includeScreenshots?: boolean; notes?: Note[] }): Promise<ExportBundle> {
  throw new Error('not implemented');
}

/** Parse and validate a bundle; throws an Error with a user-friendly message if invalid. */
export function parseExportBundle(json: string): ExportBundle {
  throw new Error('not implemented');
}

/** 'merge' keeps existing notes (newer copy wins); 'replace' deletes everything first. */
export async function importBundle(bundle: ExportBundle, mode: 'merge' | 'replace'): Promise<ImportSummary> {
  throw new Error('not implemented');
}

/** Trigger a file download from an extension page. */
export function downloadFile(filename: string, contents: string, mimeType: string): void {
  throw new Error('not implemented');
}
