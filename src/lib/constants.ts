/** Tag name of the custom element that hosts WebMark's in-page UI (the shadow host). */
export const WEBMARK_HOST_TAG = 'webmark-ui';

/**
 * Marks WebMark's host element whatever its tag: if the page defined
 * <webmark-ui> itself, the content script uses a random tag instead.
 */
export const WEBMARK_HOST_ATTR = 'data-wm-host';

/** The host element of this content script instance, if it had to use a random tag. */
let registeredHost: Element | null = null;

export function setWebmarkHost(host: Element | null): void {
  registeredHost = host;
}

export function isWebmarkHost(el: Element): boolean {
  return el === registeredHost || el.localName === WEBMARK_HOST_TAG;
}

/**
 * True if `node` is WebMark's own UI: the shadow host itself, something inside
 * it, or something inside its shadow root. Such elements must never be picked,
 * anchored or counted as page content.
 */
export function isWebmarkNode(node: Node | null | undefined): boolean {
  let current: Node | null | undefined = node;
  while (current) {
    if (current instanceof Element && isWebmarkHost(current)) return true;
    // Climb out of shadow roots via their host.
    current = current.parentNode ?? (current instanceof ShadowRoot ? current.host : null);
  }
  return false;
}

/**
 * Pins are numbered 1..n in the order returned by getNotesForPage() (oldest
 * first). The in-page pins, popup and side panel all use this so "#3" means
 * the same note everywhere.
 */
export function pinNumber(noteId: string, pageNotesOldestFirst: { id: string }[]): number {
  return pageNotesOldestFirst.findIndex((n) => n.id === noteId) + 1;
}

/** Keyboard shortcuts as declared in wxt.config.ts (users can rebind them). */
export const DEFAULT_SHORTCUTS = {
  startPicker: 'Alt+Shift+M',
  togglePins: 'Alt+Shift+P',
} as const;
