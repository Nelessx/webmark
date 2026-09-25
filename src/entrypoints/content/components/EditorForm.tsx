import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type Ref } from 'react';
import { sameFields, type EditedFields, type EditorDraft, type EditorFields } from '@/lib/editor/protocol';
import { editedFields, toDraft } from '@/lib/editor/save';
import { EditorFooter, type ConfirmState } from './EditorFooter';

const TEXTAREA_MAX_HEIGHT = 240;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export interface EditorFormProps {
  mode: 'create' | 'edit';
  noteId?: string;
  title: string;
  ariaLabel: string;
  /** Used when the label field is emptied. */
  fallbackLabel: string;
  /** Values the form opened with; saving an edit writes only the fields that differ from these. */
  initial: EditorFields;
  /** Values to start from instead (a draft restored after a reload). */
  start?: EditorFields;
  /** Screenshot preview (a data: URL already checked with safeImageSrc). */
  screenshot?: string;
  meta: string;
  /** Shown above the fields, e.g. that the page can see what is typed. */
  warning?: string;
  /** Bumped to grab focus and shake ("finish this note first"). */
  nudge: number;
  className: string;
  style?: CSSProperties;
  rootRef?: Ref<HTMLDivElement>;
  /** Resolves true when saved (the editor then goes away), false to let the user retry. */
  onSave(draft: EditorDraft, edited: EditedFields): Promise<boolean>;
  /** Close without saving: Cancel on an untouched form, or a confirmed discard. */
  onClose(): void;
  onDelete(): void;
  onCopy(values: EditorFields): void;
  onDirtyChange(dirty: boolean): void;
  onValuesChange?(values: EditorFields): void;
}

/** The note form: label, body, tags, status (edit), actions, and inline confirmations. */
export function EditorForm(props: EditorFormProps) {
  const { mode, initial, nudge, onDirtyChange, onValuesChange } = props;
  const [values, setValues] = useState<EditorFields>(() => props.start ?? initial);
  const [confirm, setConfirm] = useState<ConfirmState>('none');
  const [saving, setSaving] = useState(false);
  const [shaking, setShaking] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const dirty = !sameFields(values, initial);
  const canSave = values.body.trim().length > 0 && !saving;
  const isEdit = mode === 'edit';

  useEffect(() => onDirtyChange(dirty), [onDirtyChange, dirty]);
  useEffect(() => onValuesChange?.(values), [onValuesChange, values]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  const firstNudge = useRef(nudge);
  useEffect(() => {
    if (nudge === firstNudge.current) return;
    textareaRef.current?.focus({ preventScroll: true });
    setShaking(true);
    const timer = window.setTimeout(() => setShaking(false), 400);
    return () => window.clearTimeout(timer);
  }, [nudge]);

  // Auto-grow the textarea up to a max height, then scroll.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight + 2, TEXTAREA_MAX_HEIGHT)}px`;
  }, [values.body]);

  const set = <K extends keyof EditorFields>(key: K, value: EditorFields[K]) => setValues((v) => ({ ...v, [key]: value }));

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const ok = await props.onSave(toDraft(values, props.fallbackLabel), editedFields(values, initial));
    // On success the editor goes away; on failure let the user retry.
    if (!ok) setSaving(false);
  };

  const cancel = () => {
    if (dirty) setConfirm('discard');
    else props.onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (confirm === 'discard') props.onClose();
      else if (confirm === 'delete') setConfirm('none');
      else cancel();
    }
  };

  return (
    <div
      ref={props.rootRef}
      className={`${props.className}${shaking ? ' wm-editor--shake' : ''}`}
      style={props.style}
      data-wm-editor={mode}
      data-wm-note-id={props.noteId}
      role="dialog"
      aria-label={props.ariaLabel}
      onKeyDown={onKeyDown}
    >
      <div className="wm-editor__head">
        <span className="wm-editor__title">{props.title}</span>
        {props.screenshot && (
          <img className="wm-editor__shot" src={props.screenshot} alt="Screenshot of the element" data-wm-shot="" />
        )}
      </div>

      {props.warning && (
        <p className="wm-editor__warning" role="note" data-wm-insecure="">
          {props.warning}
        </p>
      )}

      <input
        className="wm-input wm-editor__label"
        data-wm-label=""
        value={values.label}
        onChange={(e) => set('label', e.target.value)}
        aria-label="Element label"
        placeholder="Label"
        spellCheck={false}
      />

      <textarea
        ref={textareaRef}
        className="wm-input wm-editor__body"
        data-wm-body=""
        value={values.body}
        onChange={(e) => set('body', e.target.value)}
        placeholder="What should change here?"
        aria-label="Note"
        rows={3}
      />

      <input
        className="wm-input wm-editor__tags"
        data-wm-tags=""
        value={values.tags}
        onChange={(e) => set('tags', e.target.value)}
        placeholder="Tags, comma separated"
        aria-label="Tags"
      />

      {isEdit && (
        <div className="wm-segmented" role="radiogroup" aria-label="Status" data-wm-status={values.status}>
          {(['open', 'resolved'] as const).map((status) => (
            <button
              key={status}
              type="button"
              role="radio"
              aria-checked={values.status === status}
              className="wm-segmented__option"
              data-wm-status-option={status}
              onClick={() => set('status', status)}
            >
              {status === 'open' ? 'Open' : 'Resolved'}
            </button>
          ))}
        </div>
      )}

      {props.meta && <div className="wm-editor__meta">{props.meta}</div>}

      <EditorFooter
        isEdit={isEdit}
        confirm={confirm}
        canSave={canSave}
        saving={saving}
        shortcut={IS_MAC ? '⌘↵' : 'Ctrl+Enter'}
        onSave={() => void save()}
        onCancel={cancel}
        onCopy={() => props.onCopy(values)}
        onConfirm={setConfirm}
        onDiscard={props.onClose}
        onDelete={props.onDelete}
      />
    </div>
  );
}
