import type { ElementAnchor } from '../types';
import { collectAttributes } from './attributes';
import { captureItem } from './context';
import { ancestorTagsOf, countMatches, cssEscape, docRectOf, nthOfTypeOf, tagOf } from './dom';
import { findPeers } from './peers';
import { prepareAnchor } from './score';
import { buildSelector } from './selector';
import { TEST_ID_ATTRIBUTES, stableClasses, stableIdOf } from './stability';
import { elementText } from './text';
import { buildXPath } from './xpath';

/** Capture every strategy needed to find `el` again later. */
export function createAnchor(el: Element): ElementAnchor {
  const win = el.ownerDocument.defaultView;
  const anchor: ElementAnchor = {
    selector: buildSelector(el),
    xpath: buildXPath(el),
    tagName: tagOf(el),
    classes: stableClasses(el),
    attributes: collectAttributes(el),
    text: elementText(el),
    rect: docRectOf(el),
    viewport: { width: win?.innerWidth ?? 0, height: win?.innerHeight ?? 0 },
    ancestorTags: ancestorTagsOf(el),
    nthOfType: nthOfTypeOf(el),
  };
  const id = stableIdOf(el);
  if (id) anchor.id = id;
  anchor.uniqueHooks = uniqueHooks(el.ownerDocument, anchor);

  // What else on the page could later be mistaken for this element.
  const prepared = prepareAnchor(anchor);
  const peers = findPeers(prepared, el);
  anchor.lookAlikes = peers.twins.length;
  anchor.shapeUnique = peers.numbered.length === 0;
  const item = captureItem(el, prepared.text.text, [...peers.twins, ...peers.numbered]);
  if (item) anchor.item = item;
  return anchor;
}

/** The id and test attributes that match nothing else on the page: only those identify the element. */
function uniqueHooks(doc: Document, anchor: ElementAnchor): string[] {
  const hooks: string[] = [];
  if (anchor.id && countMatches(doc, `#${cssEscape(anchor.id)}`) === 1) hooks.push('id');
  for (const name of TEST_ID_ATTRIBUTES) {
    const value = anchor.attributes[name];
    if (value && countMatches(doc, `[${name}="${cssEscape(value)}"]`) === 1) hooks.push(name);
  }
  return hooks;
}
