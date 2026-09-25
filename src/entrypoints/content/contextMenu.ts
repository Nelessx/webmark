import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { isWebmarkNode } from '@/lib/constants';
import { lightDomElement } from './dom';

/** Menu item clicks come within seconds of the right-click that opened the menu. */
export const CONTEXT_MENU_TARGET_TTL_MS = 10_000;

interface Target {
  element: WeakRef<Element>;
  at: number;
}

/**
 * Remembers the element under the right-click that opened the browser's
 * context menu, so the background's "Add WebMark note to this element" item
 * can open the editor for it. The browser doesn't tell the extension which
 * element was clicked.
 *
 * Only the user's own right-click counts: synthetic events (a page could
 * dispatch them to plant a target) are ignored, any later press forgets the
 * target, and it expires after CONTEXT_MENU_TARGET_TTL_MS. Without a target
 * the caller falls back to the element picker.
 */
export class ContextMenuTracker {
  private last: Target | null = null;

  constructor(ctx: Pick<ContentScriptContext, 'addEventListener'>) {
    // Capture on window: the earliest point our listeners can see the event.
    const options = { capture: true, passive: true };
    ctx.addEventListener(window, 'pointerdown', (event) => this.forget(event), options);
    ctx.addEventListener(window, 'contextmenu', (event) => this.remember(event), options);
  }

  /** The element the menu was opened on, if it's still on the page and worth annotating. */
  take(): Element | null {
    const target = this.last;
    this.last = null;
    if (!target || Date.now() - target.at > CONTEXT_MENU_TARGET_TTL_MS) return null;
    const el = target.element.deref();
    if (!el?.isConnected || el === document.body || el === document.documentElement) return null;
    return el;
  }

  /** A new press (it may open a menu this tracker never sees). */
  private forget(event: Event): void {
    if (event.isTrusted) this.last = null;
  }

  private remember(event: Event): void {
    if (!event.isTrusted) return;
    const el = lightDomElement(event.composedPath()[0]);
    this.last = el && !isWebmarkNode(el) ? { element: new WeakRef(el), at: Date.now() } : null;
  }
}
