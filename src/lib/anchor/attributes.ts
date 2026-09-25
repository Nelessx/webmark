import { collapseWhitespace, isPasswordField } from './dom';
import { TEST_ID_ATTRIBUTES, isStableId, looksGenerated } from './stability';

/**
 * The only attributes an anchor ever stores. Deliberately excludes `value`,
 * arbitrary data-* attributes and anything user-entered.
 */
export const IDENTIFYING_ATTRIBUTES = [
  ...TEST_ID_ATTRIBUTES,
  'name',
  'aria-label',
  'role',
  'title',
  'alt',
  'placeholder',
  'type',
  'for',
  'href',
  'src',
] as const;

/** Every attribute anchoring reads: changes to any other attribute can't change what an anchor resolves to. */
export const ANCHOR_ATTRIBUTES: readonly string[] = ['id', 'class', 'contenteditable', ...IDENTIFYING_ATTRIBUTES];

export const MAX_ATTRIBUTE_LENGTH = 200;

const IDENTIFYING = new Set<string>(IDENTIFYING_ATTRIBUTES);
const HUMAN_TEXT = new Set(['aria-label', 'title', 'alt', 'placeholder']);

/** Identifying, non-sensitive attributes of `el`, normalised so capture and resolve compare equal. */
export function collectAttributes(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  if (!el.hasAttributes()) return out;
  // Nothing from password fields beyond what kind of field it is.
  if (isPasswordField(el)) return { type: 'password' };
  // By name rather than through el.attributes: resolve reads thousands of
  // candidates, and some engines (jsdom) build a costly NamedNodeMap per call.
  for (const name of el.getAttributeNames()) {
    if (!IDENTIFYING.has(name)) continue;
    const value = normalizeAttribute(el, name, el.getAttribute(name) ?? '');
    if (value) out[name] = value;
  }
  return out;
}

export function normalizeAttribute(el: Element, name: string, raw: string): string {
  switch (name) {
    case 'href':
      return normalizeHref(el, raw);
    case 'src':
      return normalizeSrc(el, raw);
    case 'for': {
      const value = raw.trim();
      return isStableId(value) ? value : '';
    }
    case 'name': {
      const value = raw.trim();
      return value && !looksGenerated(value) ? value.slice(0, MAX_ATTRIBUTE_LENGTH) : '';
    }
    case 'type':
    case 'role':
      return raw.trim().toLowerCase().slice(0, 40);
    default:
      return (HUMAN_TEXT.has(name) ? collapseWhitespace(raw) : raw.trim()).slice(0, MAX_ATTRIBUTE_LENGTH);
  }
}

let cachedPageHref = '';
let cachedPageUrl: URL | null = null;

function pageUrl(el: Element): URL | null {
  const href = el.ownerDocument.URL;
  if (href !== cachedPageHref) {
    cachedPageHref = href;
    cachedPageUrl = parseUrl(href);
  }
  return cachedPageUrl;
}

function parseUrl(value: string, base?: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

/**
 * Same-origin links keep path + search (plus the hash for in-page and
 * hash-routed links, where the hash is the identifying part); other origins
 * keep origin + path so tokens in foreign query strings are never stored.
 */
function normalizeHref(el: Element, raw: string): string {
  const value = raw.trim();
  if (!value || /^(?:javascript|data|blob|vbscript):/i.test(value)) return '';
  if (/^(?:mailto|tel|sms):/i.test(value)) return (value.split('?')[0] ?? '').slice(0, MAX_ATTRIBUTE_LENGTH);
  const url = parseUrl(value, el.baseURI);
  if (!url || !/^(?:https?|file):$/.test(url.protocol)) return '';
  const page = pageUrl(el);
  if (page && url.protocol === page.protocol && url.host === page.host) {
    const samePage = url.pathname === page.pathname && url.search === page.search;
    const keepHash = url.hash.length > 1 && (samePage || /^#!?\//.test(url.hash));
    return `${url.pathname}${url.search}${keepHash ? url.hash : ''}`.slice(0, MAX_ATTRIBUTE_LENGTH);
  }
  return `${url.origin}${url.pathname}`.slice(0, MAX_ATTRIBUTE_LENGTH);
}

function normalizeSrc(el: Element, raw: string): string {
  const value = raw.trim();
  if (!value || /^(?:data|blob):/i.test(value)) return '';
  const url = parseUrl(value, el.baseURI);
  return url ? url.pathname.slice(0, MAX_ATTRIBUTE_LENGTH) : '';
}
