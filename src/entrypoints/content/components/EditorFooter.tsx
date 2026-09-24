export type ConfirmState = 'none' | 'discard' | 'delete';

interface EditorFooterProps {
  isEdit: boolean;
  confirm: ConfirmState;
  canSave: boolean;
  saving: boolean;
  shortcut: string;
  onSave(): void;
  onCancel(): void;
  onCopy(): void;
  onConfirm(state: ConfirmState): void;
  onDiscard(): void;
  onDelete(): void;
}

/** Action row of the editor, or an inline confirmation in its place. */
export function EditorFooter(props: EditorFooterProps) {
  const { isEdit, confirm, canSave, saving, shortcut, onSave, onCancel, onCopy, onConfirm, onDiscard, onDelete } = props;

  if (confirm === 'discard') {
    return (
      <div className="wm-editor__confirm" data-wm-confirm="discard" role="alertdialog" aria-label="Discard changes">
        <span className="wm-editor__confirm-text">Discard unsaved changes?</span>
        <button type="button" className="wm-btn" onClick={() => onConfirm('none')}>
          Keep editing
        </button>
        <button type="button" className="wm-btn wm-btn--danger" data-wm-discard="" onClick={onDiscard}>
          Discard
        </button>
      </div>
    );
  }

  if (confirm === 'delete') {
    return (
      <div className="wm-editor__confirm" data-wm-confirm="delete" role="alertdialog" aria-label="Delete note">
        <span className="wm-editor__confirm-text">Delete this note?</span>
        <button type="button" className="wm-btn" onClick={() => onConfirm('none')}>
          Keep
        </button>
        <button type="button" className="wm-btn wm-btn--danger" data-wm-delete-confirm="" onClick={onDelete}>
          Delete
        </button>
      </div>
    );
  }

  return (
    <div className="wm-editor__footer">
      {isEdit && (
        <div className="wm-editor__secondary">
          <button
            type="button"
            className="wm-btn wm-btn--ghost wm-btn--danger-text"
            data-wm-delete=""
            onClick={() => onConfirm('delete')}
          >
            Delete
          </button>
          <button type="button" className="wm-btn wm-btn--ghost" data-wm-copy="" onClick={onCopy}>
            Copy as Markdown
          </button>
        </div>
      )}
      <div className="wm-editor__primary">
        <button type="button" className="wm-btn" data-wm-cancel="" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="wm-btn wm-btn--primary"
          data-wm-save=""
          disabled={!canSave}
          onClick={onSave}
          title={`Save (${shortcut})`}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
