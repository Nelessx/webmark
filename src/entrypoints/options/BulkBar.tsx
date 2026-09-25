import { useState } from 'react';
import { Button } from '@/components/Button';
import { ConfirmButton } from '@/components/ConfirmButton';
import { IconDownload, IconTrash, IconX } from '@/components/icons';
import { MenuButton } from '@/components/MenuButton';
import { PRIORITY_MENU_OPTIONS, STATUS_MENU_OPTIONS } from '@/components/NoteMenus';
import { showToast } from '@/components/toast';
import { PRIORITY_LABELS, STATUS_LABELS } from '@/lib/noteMeta';
import { deleteNotes, updateNotes } from '@/lib/storage';
import type { Note, NotePatch } from '@/lib/types';
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
  async function run(done: string, failed: string, action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    try {
      await action();
      showToast(done, { tone: 'success' });
      return true;
    } catch {
      showToast(`${failed} Try again.`, { tone: 'danger' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Write `patch` to the selected notes it changes; the rest already have it. */
  const apply = (patch: NotePatch, changes: (note: Note) => boolean, what: string) => {
    const notes = selected.filter(changes);
    return run(`${plural(count)} set to ${what}`, `Couldn't set ${plural(count)} to ${what}.`, () =>
      updateNotes(notes.map((n) => ({ pageKey: n.pageKey, noteId: n.id, patch }))),
    );
  };

  const remove = async () => {
    const done = await run(`Deleted ${plural(count)}`, `Deleting ${plural(count)} failed.`, () =>
      deleteNotes(selected.map((n) => ({ pageKey: n.pageKey, noteId: n.id }))),
    );
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
      <MenuButton
        label="Set status"
        menuLabel={`Set the status of ${plural(count)}`}
        className="wm-btn wm-btn--secondary wm-btn--sm"
        options={STATUS_MENU_OPTIONS}
        disabled={busy}
        onSelect={(status) => void apply({ status }, (n) => n.status !== status, STATUS_LABELS[status])}
      >
        Set status
      </MenuButton>
      <MenuButton
        label="Set priority"
        menuLabel={`Set the priority of ${plural(count)}`}
        className="wm-btn wm-btn--secondary wm-btn--sm"
        options={PRIORITY_MENU_OPTIONS}
        disabled={busy}
        onSelect={(priority) =>
          void apply({ priority }, (n) => n.priority !== priority, `${PRIORITY_LABELS[priority]} priority`)
        }
      >
        Set priority
      </MenuButton>
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
