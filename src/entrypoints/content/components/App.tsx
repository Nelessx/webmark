import { findNote } from '../store';
import { Boundary } from './Boundary';
import { useAppState, useWebmark } from './context';
import { Editor } from './Editor';
import { OrphanCard } from './OrphanCard';
import { Outline } from './Outline';
import { Pins } from './Pins';
import { Toasts } from './Toasts';

export function App() {
  const { actions } = useWebmark();
  const editor = useAppState((s) => s.editor);
  const flash = useAppState((s) => s.flash);
  const pickerActive = useAppState((s) => s.pickerActive);
  const hoverElement = useAppState((s) => (s.hoverNoteId ? s.resolved.get(s.hoverNoteId) : undefined));
  const orphanNote = useAppState((s) => findNote(s, s.orphanNoteId));

  return (
    <div className={`wm-app${pickerActive ? ' wm-app--picking' : ''}`} data-wm-root="">
      {hoverElement && hoverElement !== editor?.target && <Outline element={hoverElement} variant="hover" />}
      {editor && <Outline element={editor.target} variant="target" />}
      {flash && <Outline key={`flash-${flash.id}`} element={flash.element} variant="flash" />}
      <Boundary>
        <Pins />
      </Boundary>
      {editor && (
        <Boundary key={`editor-${editor.id}`} onError={actions.cancelEditor}>
          <Editor session={editor} />
        </Boundary>
      )}
      {orphanNote && (
        <Boundary key={`orphan-${orphanNote.id}`} onError={actions.closeOrphanCard}>
          <OrphanCard note={orphanNote} />
        </Boundary>
      )}
      <Boundary>
        <Toasts />
      </Boundary>
    </div>
  );
}
