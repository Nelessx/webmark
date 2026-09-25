import type { ElementAnchor } from '../types';
import { collectAttributes } from './attributes';
import { findItemAncestor, itemText, prepareItem } from './context';
import { ancestorAt, isDocumentLevel, tagOf } from './dom';
import { normalizeForCompare } from './similarity';
import { stableClasses, stableIdOf } from './stability';
import { elementText } from './text';

/*
 * Helpers for keeping a resolved element honest while the page runs.
 * Frameworks recycle DOM nodes (index-keyed lists, pagination, virtual
 * scrolling) and rewrite their content in place, so an element that is still
 * connected may now show a different record.
 */

/**
 * The subtree whose content identifies `el` for this anchor: its recorded item
 * (card, row) when there is one, so a recycled card around an unchanged
 * "Add to cart" button is noticed; otherwise the element itself.
 */
export function watchRootFor(anchor: ElementAnchor, el: Element): Element {
  const item = prepareItem(anchor.item);
  if (!item) return el;
  const root = findItemAncestor(item, el) ?? ancestorAt(el, item.depth);
  return root && !isDocumentLevel(root) && root.contains(el) ? root : el;
}

/**
 * A cheap summary of everything resolution compares for `el` (and its item
 * `root`). When it changes, the element may be showing something else and must
 * be re-verified.
 */
export function contentFingerprint(el: Element, root: Element = el): string {
  const parts = [
    tagOf(el),
    stableIdOf(el) ?? '',
    stableClasses(el).join(' '),
    JSON.stringify(collectAttributes(el)),
    normalizeForCompare(elementText(el)),
  ];
  if (root !== el) parts.push(itemText(root));
  return parts.join('\u0000');
}
