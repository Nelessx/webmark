/** Query parameters that only track campaigns/clicks and never change page content. */
const TRACKING_PARAM = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|mc_cid|mc_eid|_ga|_gl|igshid|ref_src|_hsenc|_hsmi)$/i;

/**
 * Normalise a URL into the key notes are stored under.
 *
 * - protocol + host (incl. port) + path, trailing slashes removed
 * - query string kept (pages like `watch?v=…` differ by query) minus tracking params, sorted
 * - hash kept only when it looks like a client-side route (`#/…` or `#!/…`)
 */
export function getPageKey(href: string): string {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return href;
  }
  const path = u.pathname.replace(/\/+$/, '') || '/';
  let key = `${u.protocol}//${u.host}${path}`;

  const params = [...u.searchParams.entries()]
    .filter(([name]) => !TRACKING_PARAM.test(name))
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  if (params.length) key += `?${new URLSearchParams(params).toString()}`;

  if (/^#!?\//.test(u.hash)) {
    const route = u.hash.replace(/\/+$/, '');
    if (route !== '#' && route !== '#!') key += route;
  }
  return key;
}

/** Host part of a page key (or URL), e.g. "localhost:3000" or "example.com". */
export function siteOf(pageKeyOrUrl: string): string {
  try {
    return new URL(pageKeyOrUrl).host || pageKeyOrUrl;
  } catch {
    return pageKeyOrUrl;
  }
}

/** Page key without the protocol, for display. */
export function displayPageKey(pageKey: string): string {
  return pageKey.replace(/^[a-z]+:\/\//i, '');
}

const BLOCKED_HOSTS = [
  'chromewebstore.google.com',
  'addons.mozilla.org',
  'microsoftedge.microsoft.com',
];

/**
 * Whether WebMark's content script can run on this URL. Browsers never inject
 * extensions into their own pages or into the extension stores.
 */
export function canRunOn(href: string | undefined): boolean {
  if (!href) return false;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') return false;
  if (u.hostname === 'chrome.google.com') return !u.pathname.startsWith('/webstore');
  if (BLOCKED_HOSTS.includes(u.hostname)) return false;
  return true;
}
