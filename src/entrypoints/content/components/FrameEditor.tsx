import { useEffect, useRef, useState } from 'react';
import { browser, type PublicPath } from 'wxt/browser';
import { EDITOR_PAGE_PATH } from '@/lib/editor/protocol';
import { centerInViewport, placePopover } from '../geometry';
import type { EditorSession, EditorSurface } from '../store';
import { useAppState, useBox, useLayout, useWebmark } from './context';

const FRAME_WIDTH = 340;
const MARGIN = 8;
/** Until the frame reports its form's height. */
const DEFAULT_HEIGHT = 280;
/** Matches the form's corner radius (--wm-radius-lg). */
const RADIUS = 14;

type FrameSurface = Extract<EditorSurface, { kind: 'frame' }>;

/**
 * The editor page's address. With use_dynamic_url Chrome hands out a
 * per-session URL, so pages can't probe for WebMark by loading ours. The
 * session token rides in the fragment, which the editor removes at once.
 */
function frameUrl(token: string): string {
  return `${browser.runtime.getURL(EDITOR_PAGE_PATH as PublicPath)}#${token}`;
}

/**
 * The isolated note editor: WebMark's extension page in a frame inside our
 * closed shadow root, placed next to the element. The page can't reach the
 * frame (not even through window.frames) and never sees its keys, input,
 * clipboard or IME events.
 *
 * The frame is as tall as the viewport allows, so the form inside never
 * overflows it (no scrolling or scrollbar while a resize is on its way), and
 * clip-path shows, and lets the pointer hit, just the form's height as the
 * frame reports it. Hidden until the frame has connected and sized itself.
 */
export function FrameEditor({ session, surface }: { session: EditorSession; surface: FrameSurface }) {
  const { actions } = useWebmark();
  const layout = useLayout();
  const box = useBox(session.target);
  const nudge = useAppState((s) => s.editorNudge);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  const [src] = useState(() => frameUrl(session.token));
  const [shaking, setShaking] = useState(false);

  const shown = surface.phase === 'connected' && surface.height > 0;
  const { viewport } = layout;
  const width = Math.max(0, Math.min(FRAME_WIDTH, viewport.width - 2 * MARGIN));
  const frameHeight = Math.max(0, viewport.height - 2 * MARGIN);
  const height = Math.min(surface.height || DEFAULT_HEIGHT, frameHeight);
  const size = { width, height };
  const position = box?.connected ? placePopover(box, size, viewport) : centerInViewport(size, viewport);

  // Focusing the frame hands the keyboard to it; the editor page then focuses its note field.
  useEffect(() => {
    if (shown) frameRef.current?.focus({ preventScroll: true });
  }, [shown]);

  // "Finish this note first": grab focus and shake.
  const firstNudge = useRef(nudge);
  useEffect(() => {
    if (nudge === firstNudge.current) return;
    frameRef.current?.focus({ preventScroll: true });
    setShaking(true);
    const timer = window.setTimeout(() => setShaking(false), 400);
    return () => window.clearTimeout(timer);
  }, [nudge]);

  if (surface.phase === 'registering') return null;

  const onLoad = () => {
    // Only our page ever loads here; a second load means the frame was navigated away.
    loads.current += 1;
    if (loads.current > 1) actions.editorFrameFailed(session.id);
  };

  return (
    <div
      className={`wm-editor-frame${shaking ? ' wm-editor-frame--shake' : ''}`}
      style={{ translate: `${position.left}px ${position.top}px`, visibility: shown ? 'visible' : 'hidden' }}
    >
      <div className="wm-editor-frame__backdrop" style={{ width, height }} />
      <iframe
        ref={frameRef}
        className="wm-editor-frame__frame"
        src={src}
        title={session.mode === 'edit' ? 'WebMark note editor' : 'New WebMark note'}
        // Any origin: Chrome matches the default ('src') against the dynamic URL,
        // not the extension origin the page commits to. Only our page loads here.
        allow="clipboard-write *"
        referrerPolicy="no-referrer"
        data-wm-editor-frame={session.mode}
        onLoad={onLoad}
        style={{
          width,
          height: frameHeight,
          clipPath: `inset(0 0 ${frameHeight - height}px 0 round ${RADIUS}px)`,
        }}
      />
    </div>
  );
}
