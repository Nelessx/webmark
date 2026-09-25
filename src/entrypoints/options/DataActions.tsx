import { useRef, useState } from 'react';
import { Button } from '@/components/Button';
import { IconDownload, IconUpload } from '@/components/icons';
import { showToast } from '@/components/toast';
import { buildExportBundle, downloadFile, importBundle, parseExportBundle } from '@/lib/export';
import { notesToCsv, notesToMarkdownReport } from '@/lib/format';
import { getAllNotes } from '@/lib/storage';
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
    case 'markdown': {
      // Every stored note numbers the pins, so "#3" matches pin 3 even when
      // the report leaves some notes out (archived, filtered, not selected).
      const allNotes = await getAllNotes();
      downloadFile(`${name}.md`, notesToMarkdownReport(notes, { allNotes }), 'text/markdown');
      return;
    }
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

interface DataActionsProps {
  /** Every note. */
  notes: Note[];
  /** The notes the list shows (the default view leaves archived ones out), in list order. */
  shown: Note[];
}

/**
 * Export (report / CSV / backup) and import (JSON backup) for the notes list.
 * A backup always holds every note; a report or CSV holds what the list shows.
 */
export function DataActions({ notes, shown }: DataActionsProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<ExportKind>('markdown');
  const [busy, setBusy] = useState(false);
  const backup = kind === 'json' || kind === 'json-lite';
  const target = backup ? notes : shown;
  const everything = target.length === notes.length;

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
        {everything ? 'Export all' : `Export ${target.length} shown`}
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
