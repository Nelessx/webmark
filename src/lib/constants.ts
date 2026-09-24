/** Tag name of the custom element that hosts WebMark's in-page UI (the shadow host). */
export const WEBMARK_HOST_TAG = 'webmark-ui';

/**
 * True if `node` is WebMark's own UI: the shadow host itself, something inside
 * it, or something inside its shadow root. Such elements must never be picked,
 * anchored or counted as page content.
 */
export function isWebmarkNode(node: Node | null | undefined): boolean {
  let current: Node | null | undefined = node;
  while (current) {
    if (current instanceof Element && current.localName === WEBMARK_HOST_TAG) return true;
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
