import { useRef, useState } from 'react';
import { Button } from '@/components/Button';
import { IconDownload, IconUpload } from '@/components/icons';
import { showToast } from '@/components/toast';
import { buildExportBundle, downloadFile, importBundle, parseExportBundle } from '@/lib/export';
import { notesToCsv, notesToMarkdownReport } from '@/lib/format';
import type { Note } from '@/lib/types';

export type ExportKind = 'markdown' | 'csv' | 'json' | 'json-lite';

function fileStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function exportNotes(kind: ExportKind, notes: Note[]): Promise<void> {
  const name = `webmark-${fileStamp()}`;
  switch (kind) {
    case 'markdown':
      downloadFile(`${name}.md`, notesToMarkdownReport(notes), 'text/markdown');
      return;
    case 'csv':
      downloadFile(`${name}.csv`, notesToCsv(notes), 'text/csv');
      return;
    case 'json':
    case 'json-lite': {
      const bundle = await buildExportBundle({ notes, includeScreenshots: kind === 'json' });
      downloadFile(`${name}.json`, JSON.stringify(bundle, null, 2), 'application/json');
    }
  }
}

/** Export (report / CSV / backup) and import (JSON backup) for the notes list. */
export function DataActions({ notes, filtered }: { notes: Note[]; filtered: Note[] | null }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<ExportKind>('markdown');
  const [busy, setBusy] = useState(false);
  // When a search is active, export what the user sees.
  const target = filtered ?? notes;

  async function onExport() {
    setBusy(true);
    try {
      await exportNotes(kind, target);
      showToast(`Exported ${target.length} note${target.length === 1 ? '' : 's'}`, { tone: 'success' });
    } catch (error) {
      showToast(`Export failed: ${error instanceof Error ? error.message : String(error)}`, { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function onImportFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const bundle = parseExportBundle(await file.text());
      const { added, updated, skipped } = await importBundle(bundle, 'merge');
      showToast(`Imported: ${added} added, ${updated} updated, ${skipped} unchanged`, { tone: 'success' });
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'That file could not be imported.', { tone: 'danger' });
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <div className="wm-allnotes__actions">
      <select
        className="wm-allnotes__select"
        aria-label="Export format"
        value={kind}
        onChange={(e) => setKind(e.target.value as ExportKind)}
      >
        <option value="markdown">Markdown report</option>
        <option value="csv">CSV (spreadsheet)</option>
        <option value="json">JSON backup (with screenshots)</option>
        <option value="json-lite">JSON (no screenshots)</option>
      </select>
      <Button size="sm" icon={<IconDownload />} disabled={busy || target.length === 0} onClick={onExport}>
        {filtered ? `Export ${target.length} shown` : 'Export all'}
      </Button>
      <Button size="sm" variant="ghost" icon={<IconUpload />} disabled={busy} onClick={() => fileInput.current?.click()}>
        Import
      </Button>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => void onImportFile(e.target.files?.[0])}
      />
    </div>
  );
}
