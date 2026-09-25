import { useState } from 'react';
import { Button } from '@/components/Button';
import { ConfirmButton } from '@/components/ConfirmButton';
import { IconCheck, IconDownload, IconRotateCcw, IconTrash, IconX } from '@/components/icons';
import { showToast } from '@/components/toast';
import { deleteNotes, updateNotes } from '@/lib/storage';
import type { Note, NoteStatus } from '@/lib/types';
import { exportNotes } from './DataActions';

interface BulkBarProps {
  selected: Note[];
  shownCount: number;
  onSelectAll: () => void;
  onClear: () => void;
}

const plural = (n: number) => `${n} note${n === 1 ? '' : 's'}`;

export function BulkBar({ selected, shownCount, onSelectAll, onClear }: BulkBarProps) {
  const [busy, setBusy] = useState(false);
  const count = selected.length;

  /**
   * One storage call for the whole selection (one write per page), so open
   * pages and lists update once instead of once per note.
   */
  async function run(label: string, notes: Note[], action: (notes: Note[]) => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    try {
      await action(notes);
      showToast(`${label}: ${plural(notes.length)}`, { tone: 'success' });
      return true;
    } catch {
      showToast(`${label} failed for ${plural(notes.length)}. Try again.`, { tone: 'danger' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const setStatus = (status: NoteStatus, label: string) =>
    run(
      label,
      selected.filter((n) => n.status !== status),
      (notes) => updateNotes(notes.map((n) => ({ pageKey: n.pageKey, noteId: n.id, patch: { status } }))),
    );

  const remove = async () => {
    const done = await run('Deleted', selected, (notes) => deleteNotes(notes.map((n) => ({ pageKey: n.pageKey, noteId: n.id }))));
    if (done) onClear();
  };

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
        onConfirm={() => void remove()}
      />
      <Button size="sm" variant="ghost" icon={<IconX />} aria-label="Clear selection" onClick={onClear} disabled={busy} />
    </div>
  );
}
