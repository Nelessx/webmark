import type { DocRect } from '../types';
import { collectAttributes } from './attributes';
import { ancestorTagsOf, docRectOf, nthOfTypeOf, tagOf } from './dom';
import { normalizeForCompare } from './similarity';
import { stableClasses, stableIdOf } from './stability';
import { elementText } from './text';

/** What an element is, without its content or position: enough to tell whether two elements could be confused. */
export interface ElementKind {
  tag: string;
  id: string | undefined;
  classes: string[];
  attributes: Record<string, string>;
}

/**
 * The same facts as an anchor, read from a live candidate element. Cheap
 * fields are read up front; text and rect (the expensive ones) are filled in
 * by completeFeatures() only for candidates that could still win.
 */
export interface CandidateFeatures extends ElementKind {
  element: Element;
  ancestorTags: string[];
  nthOfType: number;
  /** Normalised text (see normalizeForCompare); undefined until completeFeatures(). */
  text?: string;
  /** Document rect; undefined until completeFeatures(), or when not needed. */
  rect?: DocRect;
  /** Whether the stored selector or XPath points at this element. */
  hint?: boolean;
  /** Whether the element sits in the anchor's recorded item; undefined when not checked. */
  itemMatch?: boolean;
}

export function readKind(el: Element): ElementKind {
  return {
    tag: tagOf(el),
    id: stableIdOf(el),
    classes: stableClasses(el),
    attributes: collectAttributes(el),
  };
}

/** `nthOfType` may be supplied when the caller already knows it (resolve computes it for all candidates in one pass). */
export function readFeatures(el: Element, nthOfType?: number): CandidateFeatures {
  return {
    ...readKind(el),
    element: el,
    ancestorTags: ancestorTagsOf(el),
    nthOfType: nthOfType ?? nthOfTypeOf(el),
  };
}

export function completeFeatures(features: CandidateFeatures, withRect: boolean): void {
  features.text ??= normalizeForCompare(elementText(features.element));
  if (withRect) features.rect = docRectOf(features.element);
}
