import { findNote } from '../store';
import { Boundary } from './Boundary';
import { useAppState, useLayerCompensation, useWebmark } from './context';
import { Editor } from './Editor';
import { FrameEditor } from './FrameEditor';
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
  const compensation = useLayerCompensation();

  return (
    <div className={`wm-app${pickerActive ? ' wm-app--picking' : ''}`} data-wm-root="" style={compensation}>
      {hoverElement && hoverElement !== editor?.target && <Outline element={hoverElement} variant="hover" />}
      {editor?.target && <Outline element={editor.target} variant="target" />}
      {flash && <Outline key={`flash-${flash.id}`} element={flash.element} variant="flash" />}
      <Boundary>
        <Pins />
      </Boundary>
      {editor && (
        <Boundary key={`editor-${editor.id}-${editor.surface.kind}`} onError={actions.cancelEditor}>
          {editor.surface.kind === 'frame' ? (
            <FrameEditor session={editor} surface={editor.surface} />
          ) : (
            <Editor session={editor} />
          )}
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
