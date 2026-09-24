import { isWebmarkNode } from '@/lib/constants';
import type { Size } from './geometry';

export type FocusableElement = Element & { focus(options?: FocusOptions): void };

/**
 * Viewport size excluding scrollbars, i.e. the box our position: fixed UI
 * lives in. In quirks mode the body, not <html>, reports the viewport.
 */
export function readViewport(): Size {
  const el = document.compatMode === 'BackCompat' ? document.body : document.documentElement;
  return {
    width: el?.clientWidth || window.innerWidth,
    height: el?.clientHeight || window.innerHeight,
  };
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** The page element that currently has focus (piercing open shadow roots), excluding WebMark's UI. */
export function pageFocus(): FocusableElement | null {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement || isWebmarkNode(el)) return null;
  return typeof (el as Partial<FocusableElement>).focus === 'function' ? (el as FocusableElement) : null;
}

/** Move focus back to a page element, but only if the user hasn't already focused something else on the page. */
export function restorePageFocus(el: FocusableElement | null): void {
  if (!el?.isConnected) return;
  const active = document.activeElement;
  const focusIsFree = !active || active === document.body || isWebmarkNode(active);
  if (!focusIsFree) return;
  try {
    el.focus({ preventScroll: true });
  } catch {
    // Some elements refuse focus; losing it is harmless.
  }
}

/**
 * Map an event target to the light-DOM element that represents it: text nodes
 * become their parent, and anything inside a page's shadow root becomes the
 * outermost host (anchors can't address shadow content).
 */
export function lightDomElement(target: EventTarget | null | undefined): Element | null {
  if (!target || typeof (target as Node).nodeType !== 'number') return null;
  let node = target as Node;
  if (node.nodeType !== Node.ELEMENT_NODE) {
    const parent = node.parentNode;
    if (!parent) return null;
    node = parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE && (parent as ShadowRoot).host ? (parent as ShadowRoot).host : parent;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  let el = node as Element;
  for (let root = el.getRootNode(); root !== document && (root as ShadowRoot).host; root = el.getRootNode()) {
    el = (root as ShadowRoot).host;
  }
  return el;
}

/**
 * Screenshots can arrive through imported bundles, so only inline image data
 * is rendered: a remote URL would make the host page fetch it.
 */
export function safeImageSrc(src: string | undefined): string | undefined {
  return src && /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(src) ? src : undefined;
}

/** Tracked timeouts so everything can be cleared at teardown. */
export class Timers {
  private readonly ids = new Set<number>();

  set(handler: () => void, ms: number): number {
    const id = window.setTimeout(() => {
      this.ids.delete(id);
      handler();
    }, ms);
    this.ids.add(id);
    return id;
  }

  clear(id: number | undefined): void {
    if (id === undefined) return;
    window.clearTimeout(id);
    this.ids.delete(id);
  }

  clearAll(): void {
    this.ids.forEach((id) => window.clearTimeout(id));
    this.ids.clear();
  }
}
