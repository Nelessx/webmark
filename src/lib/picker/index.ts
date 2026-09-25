import { createPicker } from './controller';

export interface PickerOptions {
  /** Element inside WebMark's shadow root to render the highlight box, tooltip and hint bar into. */
  container: HTMLElement;
  /**
   * WebMark's shadow root. Seen from the window, events inside a closed root
   * only show its host, so the picker asks the root what is under the
   * pointer to let clicks on our own controls (the hint's Cancel) through.
   */
  shadowRoot?: ShadowRoot;
  /** Called with the element the user confirmed. The picker has already stopped itself. */
  onPick: (el: Element) => void;
  /** Called when the user cancels (Esc or the hint's Cancel button). The picker has already stopped itself. */
  onCancel: () => void;
}

export interface PickerHandle {
  stop(): void;
  readonly active: boolean;
}

/**
 * Enter "select anything on the page" mode.
 *
 * - Hover highlights the page element under the pointer (WebMark's own UI is
 *   looked through). Click or Enter picks it, Esc cancels, ArrowUp/ArrowDown
 *   climb to the parent and back down.
 * - While active the page receives no clicks, presses or handled keys. Pointer
 *   input on WebMark's own controls (buttons, links, inputs in the shadow root)
 *   still goes through, so an in-page "Cancel" button keeps working.
 * - stop() is idempotent and calls neither callback. Starting a picker stops
 *   any previous one. If `container` is detached from the page (extension
 *   reload), the picker stops itself silently on the next event.
 */
export function startPicker(options: PickerOptions): PickerHandle {
  return createPicker(options);
}

export { createPicker, type PickerDeps } from './controller';
