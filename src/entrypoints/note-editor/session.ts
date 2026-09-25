import {
  isEditorToken,
  sameFields,
  type DraftState,
  type EditorFields,
  type EditorFrameEvent,
  type EditorSessionInfo,
} from '@/lib/editor/protocol';
import { sendToBackground } from '@/lib/messages';

/*
 * The editor frame's side of the session (see src/lib/editor/protocol.ts).
 * Everything goes through runtime messaging to the background, never
 * window.postMessage: the page embedding us could forge or read that.
 */

const DRAFT_MIRROR_MS = 300;

/** The session token from the URL fragment. Removed from the URL right away, valid or not. */
export function takeToken(): string | null {
  const token = location.hash.slice(1);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  return isEditorToken(token) ? token : null;
}

/** Claim the session. Undefined unless WebMark's content script registered it for this tab. */
export async function connect(token: string): Promise<EditorSessionInfo | undefined> {
  const response = await sendToBackground({ type: 'wm:editor-hello', token });
  return response?.ok ? response.session : undefined;
}

/** Tell the content script of our tab (through the background). Resolves once it has handled the event. */
export async function emit(token: string, event: EditorFrameEvent): Promise<boolean> {
  const response = await sendToBackground({ type: 'wm:editor-emit', token, event });
  return response?.ok === true;
}

export interface DraftMirror {
  /** The form's current values; sent (throttled) while they differ from `initial`. */
  update(initial: EditorFields, values: EditorFields): void;
  /** Stop mirroring: the note was saved or discarded. */
  cancel(): void;
}

/**
 * Keep the background's copy of the unsaved values current. It keeps them
 * in storage.session, so a reload or an SPA navigation doesn't lose a draft.
 */
export function createDraftMirror(token: string): DraftMirror {
  let pending: DraftState | null | undefined;
  let sent = false;
  let timer = 0;
  let done = false;

  const flush = () => {
    window.clearTimeout(timer);
    timer = 0;
    if (pending === undefined || done) return;
    // Nothing mirrored yet and nothing to mirror: skip the message.
    if (pending === null && !sent) {
      pending = undefined;
      return;
    }
    void sendToBackground({ type: 'wm:editor-draft', token, draft: pending });
    sent = pending !== null;
    pending = undefined;
  };
  // The frame goes away with the page: send what is left.
  window.addEventListener('pagehide', flush);

  return {
    update(initial, values) {
      if (done) return;
      pending = sameFields(initial, values) ? null : { initial, values };
      if (!timer) timer = window.setTimeout(flush, DRAFT_MIRROR_MS);
    },
    cancel() {
      done = true;
      window.clearTimeout(timer);
      window.removeEventListener('pagehide', flush);
    },
  };
}
