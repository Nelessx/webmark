/**
 * Put `el` in the browser's top layer (as a manual popover) when supported,
 * so it renders above any z-index the page uses, and so the viewport is its
 * containing block even when <html> or <body> has a transform, filter,
 * contain or will-change that would capture position: fixed. Showing it
 * again (after the element was removed and re-inserted) is fine.
 */
export function promoteToTopLayer(el: HTMLElement): boolean {
  if (typeof el.showPopover !== 'function') return false;
  try {
    el.setAttribute('popover', 'manual');
    if (!el.matches(':popover-open')) el.showPopover();
    return true;
  } catch {
    el.removeAttribute('popover');
    return false;
  }
}

/** Show `el` again, so it is above what entered the top layer since (e.g. a page's modal dialog). */
export function raiseInTopLayer(el: HTMLElement): boolean {
  try {
    if (el.matches(':popover-open')) el.hidePopover();
  } catch {
    // Not a popover (or no popover support): promoting tells.
  }
  return promoteToTopLayer(el);
}
