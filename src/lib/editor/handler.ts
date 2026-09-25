import type { Browser } from 'wxt/browser';
import { sendToTab, type BackgroundResponse, type EditorBackgroundMessage } from '../messages';
import type { EditorSessions } from './sessions';
import { isEditorFrameEvent } from './validate';

type Sender = Browser.runtime.MessageSender;

/** Background side of the isolated editor: sessions, the frame's hello, and relaying its events. */
export async function handleEditorMessage(
  sessions: EditorSessions,
  message: EditorBackgroundMessage,
  sender: Sender,
): Promise<BackgroundResponse<EditorBackgroundMessage>> {
  switch (message.type) {
    case 'wm:editor-open':
      return { ok: await sessions.open(message.token, message.request, sender) };
    case 'wm:editor-hello': {
      const response = await sessions.hello(message.token, sender);
      if (response.ok) {
        void sendToTab(response.session.tabId, {
          type: 'wm:editor-event',
          token: message.token,
          event: { kind: 'connected' },
        });
      }
      return response;
    }
    case 'wm:editor-emit': {
      const tabId = await sessions.frameTab(message.token, sender);
      if (tabId === undefined || !isEditorFrameEvent(message.event)) return { ok: false };
      const { event } = message;
      if (event.kind === 'saved' || event.kind === 'closed' || event.kind === 'deleted') await sessions.settle(message.token);
      // Awaited, so the frame knows the page has seen e.g. `deleting` before it acts.
      const delivered = await sendToTab(tabId, { type: 'wm:editor-event', token: message.token, event });
      return { ok: delivered?.ok === true };
    }
    case 'wm:editor-draft':
      return { ok: await sessions.draft(message.token, message.draft, sender) };
    case 'wm:editor-fallback':
      return sessions.fallback(message.token, sender);
    case 'wm:editor-close':
      return { ok: await sessions.close(message.token, sender) };
    case 'wm:editor-recover':
      return { request: await sessions.recover(message.pageKey, sender) };
  }
}
