import type { PageState } from './messages';

/**
 * Toolbar badge text for a tab: how many of its page's notes still need work
 * (open or in progress), or '' when none do. Completed and archived notes
 * don't count. Anything but a positive number shows nothing: page states come
 * from content scripts, which share a process with the page.
 */
export function badgeText(state: Pick<PageState, 'activeCount'> | undefined): string {
  const count = state?.activeCount;
  return typeof count === 'number' && Number.isFinite(count) && count >= 1 ? String(Math.floor(count)) : '';
}
