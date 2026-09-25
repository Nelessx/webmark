import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { pinNumber } from '@/lib/constants';
import { editorMeta, editorTitles, initialFields } from '@/lib/editor/presentation';
import { INSECURE_EDITOR_WARNING, type EditorFields } from '@/lib/editor/protocol';
import { toDraft } from '@/lib/editor/save';
import { safeImageSrc } from '../dom';
import { centerInViewport, placePopover, type Size } from '../geometry';
import type { EditorSession } from '../store';
import { useAppState, useBox, useLayout, useWebmark } from './context';
import { EditorForm } from './EditorForm';

const DEFAULT_SIZE: Size = { width: 340, height: 280 };

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

/**
 * The in-page fallback editor, used when the isolated editor frame can't
 * load (e.g. the page's COEP blocks extension frames). It lives in our
 * shadow root, so the page can observe what is typed, and says so.
 */
export function Editor({ session }: { session: EditorSession }) {
  const { actions } = useWebmark();
  const liveNote = useAppState((s) => (session.noteId ? s.notes.find((n) => n.id === session.noteId) : undefined));
  // After an SPA navigation the note is no longer among the current page's notes.
  const note = liveNote ?? session.note;
  const notes = useAppState((s) => s.notes);
  const authorName = useAppState((s) => s.settings.authorName);
  const nudge = useAppState((s) => s.editorNudge);
  const layout = useLayout();
  const box = useBox(session.target);
  const rootRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(rootRef);
  const [initial] = useState<EditorFields>(() => session.draft?.initial ?? initialFields(session.label, note));

  const onValuesChange = useCallback((values: EditorFields) => actions.mirrorDraft(values, initial), [actions, initial]);
  const copy = (values: EditorFields) => {
    if (note) void actions.copyMarkdown({ ...note, ...toDraft(values, note.label) });
  };

  const position = box?.connected ? placePopover(box, size, layout.viewport) : centerInViewport(size, layout.viewport);
  const { title, ariaLabel } = editorTitles(session.mode, note ? pinNumber(note.id, notes) : 0);

  return (
    <EditorForm
      mode={session.mode}
      noteId={session.noteId}
      title={title}
      ariaLabel={ariaLabel}
      fallbackLabel={session.label}
      initial={initial}
      start={session.draft?.values}
      screenshot={safeImageSrc(session.screenshot)}
      meta={editorMeta(session.mode, note, authorName)}
      warning={INSECURE_EDITOR_WARNING}
      nudge={nudge}
      className="wm-editor wm-editor--floating"
      style={{ translate: `${position.left}px ${position.top}px` }}
      rootRef={rootRef}
      onSave={actions.saveEditor}
      onClose={actions.cancelEditor}
      onDelete={() => session.noteId && void actions.deleteNote(session.noteId)}
      onCopy={copy}
      onDirtyChange={actions.setEditorDirty}
      onValuesChange={onValuesChange}
    />
  );
}
