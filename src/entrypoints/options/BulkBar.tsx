import { useState } from 'react';
import { Button } from '@/components/Button';
import { ConfirmButton } from '@/components/ConfirmButton';
import { IconCheck, IconDownload, IconRotateCcw, IconTrash, IconX } from '@/components/icons';
import { showToast } from '@/components/toast';
import { deleteNote, updateNote } from '@/lib/storage';
import type { Note, NoteStatus } from '@/lib/types';
import { exportNotes } from './DataActions';

interface BulkBarProps {
  selected: Note[];
  shownCount: number;
  onSelectAll: () => void;
  onClear: () => void;
}

const plural = (n: number) => `${n} note${n === 1 ? '' : 's'}`;

/** Runs one storage call per note and reports how many failed, so none are silently skipped. */
async function forEachNote(notes: Note[], action: (note: Note) => Promise<unknown>): Promise<number> {
  const results = await Promise.allSettled(notes.map(action));
  return results.filter((r) => r.status === 'rejected').length;
}

export function BulkBar({ selected, shownCount, onSelectAll, onClear }: BulkBarProps) {
  const [busy, setBusy] = useState(false);
  const count = selected.length;

  async function run(label: string, notes: Note[], action: (note: Note) => Promise<unknown>) {
    setBusy(true);
    try {
      const failed = await forEachNote(notes, action);
      if (failed) showToast(`${label}: ${failed} of ${notes.length} failed`, { tone: 'danger' });
      else showToast(`${label}: ${plural(notes.length)}`, { tone: 'success' });
    } finally {
      setBusy(false);
    }
  }

  const setStatus = (status: NoteStatus, label: string) =>
    run(
      label,
      selected.filter((n) => n.status !== status),
      (n) => updateNote(n.pageKey, n.id, { status }),
    );

  return (
    <div className="wm-allnotes__bulk" role="toolbar" aria-label="Bulk actions">
      <strong>{count} selected</strong>
      {count < shownCount ? (
        <Button size="sm" variant="ghost" onClick={onSelectAll} disabled={busy}>
          Select all {shownCount}
        </Button>
      ) : null}
      <span className="wm-allnotes__bulk-spacer" />
      <Button size="sm" icon={<IconCheck />} disabled={busy} onClick={() => void setStatus('resolved', 'Resolved')}>
        Resolve
      </Button>
      <Button size="sm" icon={<IconRotateCcw />} disabled={busy} onClick={() => void setStatus('open', 'Reopened')}>
        Reopen
      </Button>
      <Button
        size="sm"
        icon={<IconDownload />}
        disabled={busy}
        onClick={() => void exportNotes('markdown', selected).then(() => showToast(`Exported ${plural(count)}`))}
      >
        Export report
      </Button>
      <ConfirmButton
        size="sm"
        variant="danger"
        icon={<IconTrash />}
        label={`Delete ${count}`}
        confirmLabel={`Delete ${plural(count)}?`}
        disabled={busy}
        onConfirm={() =>
          void run('Deleted', selected, (n) => deleteNote(n.pageKey, n.id)).then(onClear)
        }
      />
      <Button size="sm" variant="ghost" icon={<IconX />} aria-label="Clear selection" onClick={onClear} disabled={busy} />
    </div>
  );
}
