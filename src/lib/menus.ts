import type { ContentMessage } from './messages';

/**
 * What "Add WebMark note to this element" asks the page for. WebMark's content
 * script runs in the top frame only, so it never sees a right-click inside an
 * iframe (an embed, a widget) and would annotate whatever was right-clicked
 * before. There the element picker starts instead, and the user picks.
 */
export function addNoteMenuMessage(frameId: number | undefined): ContentMessage {
  return frameId ? { type: 'wm:start-picker' } : { type: 'wm:note-from-context-menu' };
}
