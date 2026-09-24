import { WEBMARK_HOST_TAG } from '../constants';
import {
  ELEMENT_NODE,
  TEXT_NODE,
  collapseWhitespace,
  isEditingHost,
  isFormControl,
  isInsideEditable,
  isPasswordField,
} from './dom';

export const MAX_ANCHOR_TEXT = 300;
/** Bounds the walk inside huge containers; the same bound applies at capture and resolve. */
const MAX_VISITED_NODES = 2000;

/**
 * Subtrees whose text is never read: code, user-entered content (textarea
 * defaults, contenteditable regions), option lists, embedded documents and
 * WebMark's own UI.
 */
const SKIPPED_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'textarea', 'select', 'iframe', 'object', WEBMARK_HOST_TAG,
]);

function skipSubtree(el: Element): boolean {
  return SKIPPED_TAGS.has(el.localName) || isEditingHost(el);
}

/**
 * Whitespace-collapsed text of `el`, cut to `max` characters. Stops walking as
 * soon as enough text is collected, so it stays cheap on huge containers.
 * `separator` is inserted between text nodes (use ' ' for display labels so
 * "<b>Revenue</b><i>$12</i>" reads "Revenue $12"); anchors use '' like textContent.
 */
export function readText(el: Element, max: number, separator = ''): string {
  let out = '';
  let visited = 0;
  let node: Node | null = el.firstChild;
  while (node && visited++ < MAX_VISITED_NODES) {
    if (node.nodeType === TEXT_NODE) {
      out = appendCollapsed(out, (node as Text).data, separator);
      if (out.length > max) break;
    } else if (node.nodeType === ELEMENT_NODE && node.firstChild && !skipSubtree(node as Element)) {
      node = node.firstChild;
      continue;
    }
    node = nextNode(node, el);
  }
  return out.slice(0, max).trim();
}

function appendCollapsed(out: string, data: string, separator: string): string {
  let piece = data.replace(/\s+/g, ' ');
  if (separator && out) piece = separator + piece;
  if (!out || out.endsWith(' ')) piece = piece.replace(/^ +/, '');
  return piece ? out + piece : out;
}

/** Next node in document order after `node`'s subtree, staying inside `root`. */
function nextNode(node: Node, root: Node): Node | null {
  for (let current: Node | null = node; current && current !== root; current = current.parentNode) {
    if (current.nextSibling) return current.nextSibling;
  }
  return null;
}

/**
 * The text stored in an anchor and compared at resolve time. Form fields and
 * editable regions contribute only their authored hint (aria-label or
 * placeholder), never what the user typed; password fields contribute nothing.
 */
export function elementText(el: Element): string {
  if (isPasswordField(el)) return '';
  if (isFormControl(el) || isInsideEditable(el)) {
    const hint = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    return collapseWhitespace(hint).slice(0, MAX_ANCHOR_TEXT);
  }
  return readText(el, MAX_ANCHOR_TEXT);
}
