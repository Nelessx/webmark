import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { isContentMessage, listen, type ContentMessage, type ContentResponse } from '@/lib/messages';
import type { Controller } from './controller';

async function handle(controller: Controller, message: ContentMessage): Promise<ContentResponse<ContentMessage>> {
  switch (message.type) {
    case 'wm:start-picker':
      return { ok: controller.startPicker() };
    case 'wm:note-from-context-menu':
      // Responds right away; the screenshot + editor flow continues on its own.
      return { ok: controller.noteFromContextMenu() };
    case 'wm:set-pins-visible':
      return { ok: await controller.setPinsVisible(message.visible) };
    case 'wm:focus-note':
      return { found: await controller.focusNote(message.noteId) };
    case 'wm:get-page-state':
      return controller.getPageState();
    case 'wm:stop-picker':
      return { ok: controller.cancelPicker() };
    case 'wm:editor-event':
      return { ok: controller.onEditorEvent(message.token, message.event) };
  }
}

/** The content script is the only handler of ContentMessage. */
export function registerMessageHandlers(ctx: ContentScriptContext, controller: Controller): void {
  const unlisten = listen(isContentMessage, (message) => {
    if (ctx.isInvalid) return undefined;
    return handle(controller, message);
  });
  ctx.onInvalidated(unlisten);
}
