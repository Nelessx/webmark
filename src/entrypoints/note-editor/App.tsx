import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { editorMeta, editorTitles, initialFields } from '@/lib/editor/presentation';
import type { EditedFields, EditorDraft, EditorFields, EditorSessionInfo } from '@/lib/editor/protocol';
import { createNote, toDraft, updateEditedFields } from '@/lib/editor/save';
import { noteToMarkdown } from '@/lib/format';
import { deleteNote, getSettings } from '@/lib/storage';
import type { Note } from '@/lib/types';
import { copyText } from '../content/clipboard';
import { EditorForm } from '../content/components/EditorForm';
import { safeImageSrc } from '../content/dom';
import { createDraftMirror, emit } from './session';

export interface AppProps {
  token: string;
  session: EditorSessionInfo;
  /** The note being edited (edit mode). */
  note?: Note;
  /** Its pin number on the page. */
  number: number;
  authorName: string;
}

/** Report the form's height, so the content script can size our frame to it. */
function useReportHeight(ref: RefObject<HTMLElement | null>, token: string): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = -1;
    const report = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      void emit(token, { kind: 'height', height });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, token]);
}

/**
 * A cross-origin frame can't take focus on its own: the content script
 * focuses the frame, and then the note field gets the caret. Clicks on the
 * card's non-interactive parts keep focus in the field, so Esc still works.
 */
function useFieldFocus(): void {
  useEffect(() => {
    const focusField = () => {
      const active = document.activeElement;
      if (!active || active === document.body) {
        document.querySelector<HTMLElement>('[data-wm-body]')?.focus({ preventScroll: true });
      }
    };
    const keepFocus = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target && !target.closest('input, textarea, button, a[href], [tabindex]')) event.preventDefault();
    };
    window.addEventListener('focus', focusField);
    document.addEventListener('mousedown', keepFocus);
    return () => {
      window.removeEventListener('focus', focusField);
      document.removeEventListener('mousedown', keepFocus);
    };
  }, []);
}

/** The isolated note editor, running in WebMark's own page inside the tab's shadow root. */
export function App({ token, session, note, number, authorName }: AppProps) {
  const { request } = session;
  const rootRef = useRef<HTMLDivElement>(null);
  const [initial] = useState<EditorFields>(() => request.draft?.initial ?? initialFields(request.label, note));
  const mirror = useMemo(() => createDraftMirror(token), [token]);
  useReportHeight(rootRef, token);
  useFieldFocus();

  const onSave = async (draft: EditorDraft, edited: EditedFields): Promise<boolean> => {
    try {
      let saved: Note | undefined;
      if (request.mode === 'create') {
        const settings = await getSettings().catch(() => undefined);
        saved = await createNote(request, draft, settings?.authorName ?? authorName);
      } else {
        saved = await updateEditedFields(request.page.pageKey, request.noteId, draft, edited);
        if (!saved) {
          mirror.cancel();
          await emit(token, { kind: 'toast', text: 'This note no longer exists', tone: 'error' });
          await emit(token, { kind: 'closed' });
          return false;
        }
      }
      // Saved: nothing left to recover after a reload.
      mirror.cancel();
      await emit(token, { kind: 'saved', note: saved });
      return true;
    } catch {
      await emit(token, { kind: 'toast', text: "Couldn't save the note", tone: 'error' });
      return false;
    }
  };

  const onClose = () => {
    mirror.cancel();
    void emit(token, { kind: 'closed' });
  };

  const onDelete = async () => {
    if (request.mode !== 'edit') return;
    mirror.cancel();
    // Awaited: the page must know it's our own deletion before the note disappears.
    await emit(token, { kind: 'deleting' });
    try {
      await deleteNote(request.page.pageKey, request.noteId);
      await emit(token, { kind: 'deleted', noteId: request.noteId });
    } catch {
      await emit(token, { kind: 'toast', text: "Couldn't delete the note", tone: 'error' });
    }
  };

  const onCopy = async (values: EditorFields) => {
    if (!note) return;
    // Copied in this document: the page never sees a copy event.
    const ok = await copyText(noteToMarkdown({ ...note, ...toDraft(values, note.label) }), document.body);
    await emit(
      token,
      ok ? { kind: 'toast', text: 'Copied to clipboard', tone: 'info' } : { kind: 'toast', text: "Couldn't copy to the clipboard", tone: 'error' },
    );
  };

  const onDirtyChange = useCallback((dirty: boolean) => void emit(token, { kind: 'dirty', dirty }), [token]);
  const onValuesChange = useCallback((values: EditorFields) => mirror.update(initial, values), [mirror, initial]);
  const { title, ariaLabel } = editorTitles(request.mode, number);

  return (
    <EditorForm
      mode={request.mode}
      noteId={request.mode === 'edit' ? request.noteId : undefined}
      title={title}
      ariaLabel={ariaLabel}
      fallbackLabel={request.label}
      initial={initial}
      start={request.draft?.values}
      screenshot={request.mode === 'create' ? safeImageSrc(request.screenshot) : undefined}
      meta={editorMeta(request.mode, note, authorName)}
      nudge={0}
      className="wm-editor"
      rootRef={rootRef}
      onSave={onSave}
      onClose={onClose}
      onDelete={() => void onDelete()}
      onCopy={(values) => void onCopy(values)}
      onDirtyChange={onDirtyChange}
      onValuesChange={onValuesChange}
    />
  );
}
