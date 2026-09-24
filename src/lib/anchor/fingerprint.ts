import type { DocRect, ElementAnchor } from '../types';
import { collectAttributes } from './attributes';
import { ancestorTagsOf, docRectOf, nthOfTypeOf, tagOf } from './dom';
import { buildSelector } from './selector';
import { normalizeForCompare } from './similarity';
import { isStableId, stableClasses } from './stability';
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
  return anchor;
}

export function stableIdOf(el: Element): string | undefined {
  const id = el.getAttribute('id');
  return id && isStableId(id) ? id : undefined;
}

/**
 * The same facts as an anchor, read from a live candidate element. Cheap
 * fields are read up front; text and rect (the expensive ones) are filled in
 * by completeFeatures() only for candidates that could still win.
 */
export interface CandidateFeatures {
  element: Element;
  tag: string;
  id: string | undefined;
  classes: string[];
  attributes: Record<string, string>;
  ancestorTags: string[];
  nthOfType: number;
  /** Normalised text (see normalizeForCompare); undefined until completeFeatures(). */
  text?: string;
  /** Document rect; undefined until completeFeatures(), or when not needed. */
  rect?: DocRect;
  /** Whether the stored selector or XPath points at this element. */
  hint?: boolean;
}

/** `nthOfType` may be supplied when the caller already knows it (resolve computes it for all candidates in one pass). */
export function readFeatures(el: Element, nthOfType?: number): CandidateFeatures {
  return {
    element: el,
    tag: tagOf(el),
    id: stableIdOf(el),
    classes: stableClasses(el),
    attributes: collectAttributes(el),
    ancestorTags: ancestorTagsOf(el),
    nthOfType: nthOfType ?? nthOfTypeOf(el),
  };
}

export function completeFeatures(features: CandidateFeatures, withRect: boolean): void {
  features.text = normalizeForCompare(elementText(features.element));
  if (withRect) features.rect = docRectOf(features.element);
}
