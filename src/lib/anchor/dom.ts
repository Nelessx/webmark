import type { DocRect } from '../types';

// Numeric node types: `instanceof` and `Node.*` constants break across realms
// (iframes, and the content-script isolated world in Firefox).
export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const DOCUMENT_NODE = 9;
export const DOCUMENT_FRAGMENT_NODE = 11;
/** Node.DOCUMENT_POSITION_FOLLOWING */
export const POSITION_FOLLOWING = 4;

export const MAX_ANCESTORS = 12;

export type QueryRoot = Document | ShadowRoot;

/** Lower-case tag name; localName keeps SVG names like "linearGradient" intact before lowering. */
export function tagOf(el: Element): string {
  return el.localName.toLowerCase();
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Shorten to `max` characters, ending with an ellipsis when cut. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The document or shadow root `el` lives in: selectors must be verified against this. */
export function queryRoot(el: Element): QueryRoot {
  const root = el.getRootNode();
  if (root.nodeType === DOCUMENT_NODE) return root as Document;
  if (root.nodeType === DOCUMENT_FRAGMENT_NODE && 'host' in root) return root as ShadowRoot;
  return el.ownerDocument;
}

/** Parent element, climbing out of shadow roots through their host. */
export function composedParent(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const parent = el.parentNode;
  if (parent && parent.nodeType === DOCUMENT_FRAGMENT_NODE && 'host' in parent) {
    return (parent as ShadowRoot).host;
  }
  return null;
}

/** How many elements `selector` matches in `root` (0 for an invalid selector). */
export function countMatches(root: QueryRoot, selector: string): number {
  try {
    return root.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

/** <html> and <body>: never an element's "item", and too big to watch. */
export function isDocumentLevel(el: Element): boolean {
  const tag = tagOf(el);
  return tag === 'html' || tag === 'body';
}

/** The ancestor `depth` levels above `el` (1 = parent), or null. */
export function ancestorAt(el: Element, depth: number): Element | null {
  let current: Element | null = el;
  for (let i = 0; i < depth && current; i++) current = current.parentElement;
  return current;
}

/** CSS.escape with a spec-compliant fallback (jsdom has no CSS.escape). */
export function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return cssEscapeFallback(value);
}

/** Port of https://drafts.csswg.org/cssom/#serialize-an-identifier */
export function cssEscapeFallback(value: string): string {
  let result = '';
  const first = value.charCodeAt(0);
  if (value.length === 1 && first === 0x2d) return `\\${value}`;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0) {
      result += '�';
    } else if (
      (code >= 0x01 && code <= 0x1f) ||
      code === 0x7f ||
      (i === 0 && code >= 0x30 && code <= 0x39) ||
      (i === 1 && code >= 0x30 && code <= 0x39 && first === 0x2d)
    ) {
      result += `\\${code.toString(16)} `;
    } else if (
      code >= 0x80 ||
      code === 0x2d ||
      code === 0x5f ||
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a)
    ) {
      result += value.charAt(i);
    } else {
      result += `\\${value.charAt(i)}`;
    }
  }
  return result;
}

export function isPasswordField(el: Element): boolean {
  return tagOf(el) === 'input' && (el.getAttribute('type') ?? '').trim().toLowerCase() === 'password';
}

/** input / textarea / select: elements whose content is user-entered. */
export function isFormControl(el: Element): boolean {
  const tag = tagOf(el);
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

export function isEditingHost(el: Element): boolean {
  const value = el.getAttribute('contenteditable');
  return value !== null && value.toLowerCase() !== 'false';
}

/** True when `el` is, or sits inside, a contenteditable region (user-typed content). */
export function isInsideEditable(el: Element): boolean {
  for (let current: Element | null = el; current; current = current.parentElement) {
    if (isEditingHost(current)) return true;
  }
  return false;
}

/** Bounding box in document coordinates (viewport rect + scroll offset), rounded. */
export function docRectOf(el: Element): DocRect {
  const rect = el.getBoundingClientRect();
  const win = el.ownerDocument.defaultView;
  return {
    x: Math.round(rect.left + (win?.scrollX ?? 0)),
    y: Math.round(rect.top + (win?.scrollY ?? 0)),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/** Zero-size rects come from hidden elements and from jsdom: they carry no positional evidence. */
export function hasArea(rect: DocRect | null | undefined): rect is DocRect {
  return !!rect && rect.width > 0 && rect.height > 0;
}

/** Ancestor tag names, nearest first, excluding <html>. */
export function ancestorTagsOf(el: Element, max = MAX_ANCESTORS): string[] {
  const tags: string[] = [];
  for (let current = el.parentElement; current && tags.length < max; current = current.parentElement) {
    const tag = tagOf(current);
    if (tag === 'html') break;
    tags.push(tag);
  }
  return tags;
}

/** 1-based index among same-tag siblings (like :nth-of-type). */
export function nthOfTypeOf(el: Element): number {
  let n = 1;
  for (let sibling = el.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
    if (sibling.localName === el.localName && sibling.namespaceURI === el.namespaceURI) n++;
  }
  return n;
}
