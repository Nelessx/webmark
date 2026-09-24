import { cssEscape, isPasswordField, nthOfTypeOf, queryRoot, type QueryRoot } from './dom';
import { TEST_ID_ATTRIBUTES, isStableId, looksGenerated, rankClasses, stableClasses } from './stability';

const MAX_VALUE_LENGTH = 80;
const MAX_CLASSES = 4;
/** Weaker hooks, tried after classes. */
const SECONDARY_ATTRIBUTES = ['href', 'for', 'alt', 'placeholder', 'title', 'role', 'type'] as const;

interface Hook {
  element: Element;
  selector: string;
}

/**
 * Shortest unique selector for `el`, preferring stable hooks in this order:
 * stable #id, test attributes, [name], [aria-label], stable classes, other
 * attributes, then :nth-of-type. When `el` has no unique hook of its own it is
 * scoped under the nearest ancestor with a stable id / test attribute, and
 * failing that, a child path is built bottom-up until it is unique.
 */
export function buildSelector(el: Element): string {
  const root = queryRoot(el);
  const own = ownSelectors(el);
  const direct = own.find((selector) => isUniqueMatch(root, selector, el));
  if (direct) return direct;

  const hook = nearestHook(el, root);
  if (hook) {
    const scoped = scopedToHook(el, hook, root, own);
    if (scoped) return scoped;
  }
  return climb(el, root);
}

/** True when `selector` matches exactly one element in `root` and it is `el`. */
export function isUniqueMatch(root: QueryRoot, selector: string, el: Element): boolean {
  try {
    const found = root.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

function attributeSelector(name: string, value: string | null, prefix = ''): string | null {
  if (!value || value.length > MAX_VALUE_LENGTH || /[\n\r]/.test(value)) return null;
  return `${prefix}[${name}="${cssEscape(value)}"]`;
}

/** Candidate simple selectors for `el` alone, best first. Always ends with the bare tag. */
export function ownSelectors(el: Element): string[] {
  const tag = cssEscape(el.localName);
  const out: string[] = [];
  const push = (selector: string | null) => {
    if (selector && !out.includes(selector)) out.push(selector);
  };

  const id = el.getAttribute('id');
  if (id && isStableId(id)) push(`#${cssEscape(id)}`);
  for (const name of TEST_ID_ATTRIBUTES) push(attributeSelector(name, el.getAttribute(name)));

  const password = isPasswordField(el);
  if (!password) {
    const name = el.getAttribute('name');
    if (name && !looksGenerated(name)) push(attributeSelector('name', name, tag));
    push(attributeSelector('aria-label', el.getAttribute('aria-label'), tag));
  }

  const classes = rankClasses(stableClasses(el))
    .slice(0, MAX_CLASSES)
    .map((name) => `.${cssEscape(name)}`);
  for (const cls of classes) push(tag + cls);
  for (let i = 0; i < classes.length; i++) {
    for (let j = i + 1; j < classes.length; j++) push(`${tag}${classes[i]}${classes[j]}`);
  }

  if (password) {
    push(`${tag}[type="password"]`);
  } else {
    for (const name of SECONDARY_ATTRIBUTES) push(secondarySelector(el, tag, name));
  }
  push(tag);
  return out;
}

function secondarySelector(el: Element, tag: string, name: (typeof SECONDARY_ATTRIBUTES)[number]): string | null {
  const value = el.getAttribute(name);
  if (!value) return null;
  // Query strings and script URLs make fragile, possibly sensitive selectors.
  if (name === 'href' && (/[?]/.test(value) || /^(?:javascript|data):/i.test(value))) return null;
  if (name === 'for' && !isStableId(value)) return null;
  return attributeSelector(name, value, tag);
}

function nthSegment(el: Element): string {
  return `${cssEscape(el.localName)}:nth-of-type(${nthOfTypeOf(el)})`;
}

function matchesOnly(siblings: HTMLCollection, selector: string, el: Element): boolean {
  let matched = false;
  for (let i = 0; i < siblings.length; i++) {
    const sibling = siblings[i];
    if (!sibling) continue;
    let matches = false;
    try {
      matches = sibling.matches(selector);
    } catch {
      return false;
    }
    if (!matches) continue;
    if (sibling !== el) return false;
    matched = true;
  }
  return matched;
}

/** The best own selector that singles `el` out among its siblings, else :nth-of-type. */
function siblingSegment(el: Element): string {
  const parent = el.parentNode;
  const siblings = parent && 'children' in parent ? (parent as ParentNode).children : null;
  if (siblings) {
    const unique = ownSelectors(el).find((selector) => matchesOnly(siblings, selector, el));
    if (unique) return unique;
  }
  return nthSegment(el);
}

function nearestHook(el: Element, root: QueryRoot): Hook | null {
  for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const id = ancestor.getAttribute('id');
    if (id && isStableId(id)) {
      const selector = `#${cssEscape(id)}`;
      if (isUniqueMatch(root, selector, ancestor)) return { element: ancestor, selector };
    }
    for (const name of TEST_ID_ATTRIBUTES) {
      const selector = attributeSelector(name, ancestor.getAttribute(name));
      if (selector && isUniqueMatch(root, selector, ancestor)) return { element: ancestor, selector };
    }
  }
  return null;
}

/**
 * "#hook el" first (survives wrapper changes), then the exact child path
 * "#hook > a > b:nth-of-type(3)". A descendant ":nth-of-type" would also match
 * same-index elements at other depths once the page changes.
 */
function scopedToHook(el: Element, hook: Hook, root: QueryRoot, own: string[]): string | null {
  for (const selector of own) {
    const scoped = `${hook.selector} ${selector}`;
    if (isUniqueMatch(root, scoped, el)) return scoped;
  }
  const segments: string[] = [];
  for (let current: Element | null = el; current && current !== hook.element; current = current.parentElement) {
    segments.unshift(siblingSegment(current));
  }
  const path = `${hook.selector} > ${segments.join(' > ')}`;
  return isUniqueMatch(root, path, el) ? path : null;
}

/** Child path built bottom-up until unique, anchored on the first ancestor that is unique by itself. */
function climb(el: Element, root: QueryRoot): string {
  const segments: string[] = [];
  for (let current: Element | null = el; current; current = current.parentElement) {
    segments.unshift(siblingSegment(current));
    const path = segments.join(' > ');
    if (isUniqueMatch(root, path, el)) return path;
    const parent: Element | null = current.parentElement;
    if (!parent) return path;
    const prefix = ownSelectors(parent).find((selector) => isUniqueMatch(root, selector, parent));
    if (prefix) {
      const anchored = `${prefix} > ${path}`;
      if (isUniqueMatch(root, anchored, el)) return anchored;
    }
  }
  return segments.join(' > ');
}
