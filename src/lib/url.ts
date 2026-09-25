/** Query parameters that only track campaigns/clicks and never change page content. */
const TRACKING_PARAM = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|mc_cid|mc_eid|_ga|_gl|igshid|ref_src|_hsenc|_hsmi)$/i;

/**
 * Query/fragment parameters that carry a credential instead of naming content:
 * magic-link and preview-share tokens, OAuth/OIDC tokens (also in `#access_token=…`
 * fragments), API keys, passwords, signed-URL signatures (AWS S3, GCS, Azure
 * SAS `sig`), OAuth 1.0a tokens, and session ids passed in the URL. Such URLs
 * are one-off by nature, so dropping these from the page key loses nothing,
 * and the notes' saved URLs and exports must not leak them.
 *
 * Deliberately NOT listed: id, v, q, page, key, code, state, … — these
 * commonly identify the content (a video, a search, a record), and a false
 * positive would merge different pages into one.
 *
 * Names are compared lower-cased with "-" read as "_" (X-Amz-Signature).
 */
const SENSITIVE_PARAMS = new Set([
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'auth_token',
  'api_key',
  'apikey',
  'password',
  'passwd',
  'pwd',
  'secret',
  'client_secret',
  'signature',
  'sig',
  'x_amz_signature',
  'x_amz_credential',
  'x_amz_security_token',
  'x_goog_signature',
  'x_goog_credential',
  'oauth_token',
  'oauth_token_secret',
  'oauth_signature',
  'jwt',
  'sessionid',
  'session_id',
  'jsessionid',
  'phpsessid',
  'sid',
]);

/** Java servlet session ids appended to a path segment: /cart;jsessionid=1A2B */
const PATH_SESSION_ID = /;jsessionid=[^/?#]*/gi;

/** What replaces a credential in a saved URL, so readers see that one was there. */
export const REDACTED = 'REDACTED';

export function isSensitiveParam(name: string): boolean {
  return SENSITIVE_PARAMS.has(name.trim().toLowerCase().replace(/-/g, '_'));
}

/** Decoded name of a raw `name=value` pair, or undefined when it isn't valid percent-encoding. */
function paramName(pair: string): string | undefined {
  const raw = pair.split('=', 1)[0] ?? '';
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return undefined;
  }
}

function isSensitivePair(pair: string): boolean {
  const name = paramName(pair);
  return name !== undefined && isSensitiveParam(name);
}

/**
 * Rewrite the sensitive pairs of a raw `a=1&b=2` string, leaving every other
 * byte alone so URLs without credentials come out unchanged.
 */
function rewritePairs(query: string, rewrite: (pair: string) => string | null): string {
  return query
    .split('&')
    .map((pair) => (isSensitivePair(pair) ? rewrite(pair) : pair))
    .filter((pair): pair is string => pair !== null)
    .join('&');
}

const redactPair = (pair: string) => `${pair.split('=', 1)[0]}=${REDACTED}`;

/**
 * The parameter part of a fragment: after "?" in a hash route (#/reset?token=…),
 * or the whole fragment when it is itself a parameter list (#access_token=…).
 * Returns [prefix, params], or undefined for a plain anchor like #section-2.
 */
function splitFragment(fragment: string): [string, string] | undefined {
  if (/^!?\//.test(fragment)) {
    const q = fragment.indexOf('?');
    return q < 0 ? undefined : [fragment.slice(0, q + 1), fragment.slice(q + 1)];
  }
  return fragment.includes('=') ? ['', fragment] : undefined;
}

/** A hash route (#/… or #!/…) without its sensitive parameters. */
function sanitizeRoute(route: string): string {
  const parts = splitFragment(route.slice(1));
  if (!parts || !parts[1].split('&').some(isSensitivePair)) return route;
  const params = rewritePairs(parts[1], () => null);
  return `#${params ? parts[0] + params : parts[0].slice(0, -1)}`;
}

/**
 * Normalise a URL into the key notes are stored under.
 *
 * - protocol + host (incl. port) + path, trailing slashes removed
 * - query string kept (pages like `watch?v=…` differ by query) minus tracking
 *   params and credentials (see SENSITIVE_PARAMS), sorted
 * - hash kept only when it looks like a client-side route (`#/…` or `#!/…`)
 */
export function getPageKey(href: string): string {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return href;
  }
  const path = u.pathname.replace(PATH_SESSION_ID, '').replace(/\/+$/, '') || '/';
  let key = `${u.protocol}//${u.host}${path}`;

  const params = [...u.searchParams.entries()]
    .filter(([name]) => !TRACKING_PARAM.test(name) && !isSensitiveParam(name))
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  if (params.length) key += `?${new URLSearchParams(params).toString()}`;

  if (/^#!?\//.test(u.hash)) {
    const route = sanitizeRoute(u.hash).replace(/\/+$/, '');
    if (route !== '#' && route !== '#!') key += route;
  }
  return key;
}

/** Whether a URL or page key carries a credential in its path, query or fragment. */
function hasSensitiveParts(href: string): boolean {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (u.username || u.password || /;jsessionid=/i.test(u.pathname)) return true;
  if ([...u.searchParams.keys()].some(isSensitiveParam)) return true;
  const fragment = splitFragment(u.hash.slice(1));
  return !!fragment && fragment[1].split('&').some(isSensitivePair);
}

/**
 * A stored page key without credentials. Keys saved before credentials were
 * dropped are re-keyed; every other key is returned exactly as it is.
 */
export function sanitizePageKey(pageKey: string): string {
  return hasSensitiveParts(pageKey) ? getPageKey(pageKey) : pageKey;
}

/**
 * A full URL with credential values replaced by REDACTED: sensitive query
 * parameters, token-bearing fragments (#access_token=…, #/reset?token=…), a
 * `;jsessionid=` path parameter and `user:password@`. URLs without
 * credentials are returned unchanged.
 */
export function redactUrl(href: string): string {
  if (!hasSensitiveParts(href)) return href;
  const u = new URL(href);
  u.username = '';
  u.password = '';
  u.pathname = u.pathname.replace(PATH_SESSION_ID, `;jsessionid=${REDACTED}`);
  if (u.search.length > 1) u.search = rewritePairs(u.search.slice(1), redactPair);
  const fragment = splitFragment(u.hash.slice(1));
  if (fragment) u.hash = fragment[0] + rewritePairs(fragment[1], redactPair);
  return u.href;
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

/** Schemes a note's page can have: the ones WebMark's content script runs on. */
export function isPageUrl(href: string): boolean {
  try {
    return ['http:', 'https:', 'file:'].includes(new URL(href).protocol);
  } catch {
    return false;
  }
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
  if (!href || !isPageUrl(href)) return false;
  const u = new URL(href);
  if (u.hostname === 'chrome.google.com') return !u.pathname.startsWith('/webstore');
  if (BLOCKED_HOSTS.includes(u.hostname)) return false;
  return true;
}
