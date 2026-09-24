import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { isWebmarkNode } from '@/lib/constants';
import { lightDomElement } from './dom';

/**
 * Remembers the element under the last right-click, so the background's
 * "Add WebMark note to this element" menu item can open the editor for it.
 * The browser doesn't tell the extension which element was clicked.
 */
export class ContextMenuTracker {
  private last: WeakRef<Element> | null = null;

  constructor(ctx: ContentScriptContext) {
    ctx.addEventListener(
      document,
      'contextmenu',
      (event) => {
        const el = lightDomElement(event.composedPath()[0]);
        this.last = el && !isWebmarkNode(el) ? new WeakRef(el) : null;
      },
      { capture: true, passive: true },
    );
  }

  /** The last right-clicked element if it's still on the page and worth annotating. */
  take(): Element | null {
    const el = this.last?.deref();
    this.last = null;
    if (!el?.isConnected || el === document.body || el === document.documentElement) return null;
    return el;
  }
}
