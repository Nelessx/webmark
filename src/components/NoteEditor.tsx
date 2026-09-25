import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { parseTags } from '@/lib/format';
import { NOTE_LIMITS } from '@/lib/limits';
import type { Note, NotePatch } from '@/lib/types';
import { Button } from './Button';
import { IconCheck } from './icons';
import { Kbd } from './Kbd';

export interface NoteEditorProps {
  note: Note;
  /** Receives only the fields the user changed in this form. Reject to keep the editor open. */
  onSave: (patch: NotePatch) => Promise<void>;
  onCancel: () => void;
}

function sameTags(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

function safeParseTags(input: string, fallback: string[]): string[] {
  try {
    return parseTags(input);
  } catch {
    return fallback;
  }
}

/** Inline edit form for a note: label, body, tags. Ctrl/Cmd+Enter saves, Esc cancels. */
export function NoteEditor({ note, onSave, onCancel }: NoteEditorProps) {
  // Changes are measured against the note as the form opened with it, not the
  // live `note`: if the note is edited elsewhere meanwhile (say, on the page),
  // fields untouched here must not be written back with their old values.
  const [initial] = useState(() => ({ label: note.label, body: note.body, tags: note.tags }));
  const [label, setLabel] = useState(initial.label);
  const [body, setBody] = useState(initial.body);
  const [tags, setTags] = useState(initial.tags.join(', '));
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Grow the textarea with its content (CSS caps the height).
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [body]);

  // Like the editor on the page: a note always has text. (An emptied note used
  // to be saved here, and the page's editor then refused every change to it.)
  const canSave = body.trim() !== '';

  const save = async () => {
    if (saving || !canSave) return;
    const patch: NotePatch = {};
    const nextLabel = label.trim() || initial.label;
    if (nextLabel !== initial.label) patch.label = nextLabel;
    const nextBody = body.trim();
    if (nextBody !== initial.body) patch.body = nextBody;
    const nextTags = safeParseTags(tags, initial.tags);
    if (!sameTags(nextTags, initial.tags)) patch.tags = nextTags;
    if (!Object.keys(patch).length) {
      onCancel();
      return;
    }
    setSaving(true);
    try {
      await onSave(patch);
    } catch {
      // The caller reports the failure; keep the user's edits.
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  return (
    <form
      className="wm-note-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="wm-field">
        <label className="wm-field__label" htmlFor={`${id}-label`}>
          Element
        </label>
        <input
          id={`${id}-label`}
          className="wm-input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Dashboard → Revenue card"
          autoComplete="off"
          maxLength={NOTE_LIMITS.label}
        />
      </div>
      <div className="wm-field">
        <label className="wm-field__label" htmlFor={`${id}-body`}>
          Note
        </label>
        <textarea
          id={`${id}-body`}
          ref={bodyRef}
          className="wm-input wm-textarea"
          value={body}
          rows={3}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What should change?"
          maxLength={NOTE_LIMITS.body}
          aria-invalid={!canSave || undefined}
        />
      </div>
      <div className="wm-field">
        <label className="wm-field__label" htmlFor={`${id}-tags`}>
          Tags
        </label>
        <input
          id={`${id}-tags`}
          className="wm-input"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="bug, copy, design"
          autoComplete="off"
          aria-describedby={`${id}-tags-hint`}
        />
        <span id={`${id}-tags-hint`} className="wm-field__hint">
          Separate tags with commas
        </span>
      </div>
      <div className="wm-note-editor__actions">
        <span className="wm-note-editor__hint">
          <Kbd shortcut="Ctrl+Enter" decorative /> to save
        </span>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          type="submit"
          icon={<IconCheck size={14} />}
          disabled={saving || !canSave}
          title={canSave ? undefined : 'Write a note first'}
        >
          Save
        </Button>
      </div>
    </form>
  );
}
