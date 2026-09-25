import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { pinNumber } from '@/lib/constants';
import { formatRelativeTime, parseTags } from '@/lib/format';
import type { NoteStatus } from '@/lib/types';
import { safeImageSrc } from '../dom';
import { centerInViewport, placePopover, type Size } from '../geometry';
import type { EditorSession } from '../store';
import { useAppState, useBox, useLayout, useWebmark } from './context';
import { EditorFooter, type ConfirmState } from './EditorFooter';

const DEFAULT_SIZE: Size = { width: 340, height: 280 };
const TEXTAREA_MAX_HEIGHT = 240;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

interface FormValues {
  label: string;
  body: string;
  tags: string;
  status: NoteStatus;
}

function sameValues(a: FormValues, b: FormValues): boolean {
  return a.label === b.label && a.body === b.body && a.tags === b.tags && a.status === b.status;
}

/** Popover size, tracked so placement can flip/clamp it into the viewport. */
function useElementSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>(DEFAULT_SIZE);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export function Editor({ session }: { session: EditorSession }) {
  const { actions } = useWebmark();
  const note = useAppState((s) => (session.noteId ? s.notes.find((n) => n.id === session.noteId) : undefined));
  const notes = useAppState((s) => s.notes);
  const authorName = useAppState((s) => s.settings.authorName);
  const nudge = useAppState((s) => s.editorNudge);
  const layout = useLayout();
  const box = useBox(session.target);

  const [initial] = useState<FormValues>(() => ({
    label: session.label,
    body: note?.body ?? '',
    tags: note?.tags.join(', ') ?? '',
    status: note?.status ?? 'open',
  }));
  const [values, setValues] = useState<FormValues>(initial);
  const [confirm, setConfirm] = useState<ConfirmState>('none');
  const [saving, setSaving] = useState(false);
  const [shaking, setShaking] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const size = useElementSize(rootRef);

  const dirty = !sameValues(values, initial);
  const canSave = values.body.trim().length > 0 && !saving;
  const isEdit = session.mode === 'edit';

  useEffect(() => actions.setEditorDirty(dirty), [actions, dirty]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  // "Finish this note first": grab focus and shake.
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

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const edited = (Object.keys(initial) as (keyof FormValues)[]).filter((key) => values[key] !== initial[key]);
    const ok = await actions.saveEditor(
      {
        label: values.label.trim() || session.label,
        body: values.body.trim(),
        tags: parseTags(values.tags),
        status: values.status,
      },
      edited,
    );
    // On success the editor unmounts; on failure let the user retry.
    if (!ok) setSaving(false);
  };

  const cancel = () => {
    if (dirty) setConfirm('discard');
    else actions.cancelEditor();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (confirm === 'discard') actions.cancelEditor();
      else if (confirm === 'delete') setConfirm('none');
      else cancel();
    }
  };

  const copy = () => {
    if (!note) return;
    void actions.copyMarkdown({
      ...note,
      label: values.label.trim() || note.label,
      body: values.body.trim(),
      tags: parseTags(values.tags),
      status: values.status,
    });
  };

  const position = box?.connected ? placePopover(box, size, layout.viewport) : centerInViewport(size, layout.viewport);
  const number = note ? pinNumber(note.id, notes) : 0;
  const shot = safeImageSrc(session.screenshot);
  const metaLine = isEdit
    ? [note?.author, note && `created ${formatRelativeTime(note.createdAt)}`].filter(Boolean).join(' · ')
    : authorName
      ? `Posting as ${authorName}`
      : '';

  return (
    <div
      ref={rootRef}
      className={`wm-editor${shaking ? ' wm-editor--shake' : ''}`}
      data-wm-editor={isEdit ? 'edit' : 'create'}
      data-wm-note-id={session.noteId}
      role="dialog"
      aria-label={isEdit ? `WebMark note ${number}` : 'New WebMark note'}
      style={{ translate: `${position.left}px ${position.top}px` }}
      onKeyDown={onKeyDown}
    >
      <div className="wm-editor__head">
        <span className="wm-editor__title">{isEdit ? `Note #${number}` : 'New note'}</span>
        {shot && <img className="wm-editor__shot" src={shot} alt="Screenshot of the element" data-wm-shot="" />}
      </div>

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

      {metaLine && <div className="wm-editor__meta">{metaLine}</div>}

      <EditorFooter
        isEdit={isEdit}
        confirm={confirm}
        canSave={canSave}
        saving={saving}
        shortcut={IS_MAC ? '⌘↵' : 'Ctrl+Enter'}
        onSave={() => void save()}
        onCancel={cancel}
        onCopy={copy}
        onConfirm={setConfirm}
        onDiscard={actions.cancelEditor}
        onDelete={() => session.noteId && void actions.deleteNote(session.noteId)}
      />
    </div>
  );
}
