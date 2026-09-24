// CONTRACT STUB — implemented by the anchor module owner. Signatures are fixed.
import type { ElementAnchor } from '../types';

export interface ResolveResult {
  element: Element;
  /** 0..1 — how sure we are this is the same element. */
  confidence: number;
  method: 'selector' | 'xpath' | 'fuzzy';
}

/** Capture every strategy needed to find `el` again later. */
export function createAnchor(el: Element): ElementAnchor {
  throw new Error('not implemented');
}

/** Find the element an anchor refers to, or null if no candidate is convincing enough. */
export function resolveAnchor(anchor: ElementAnchor, doc: Document = document): ResolveResult | null {
  throw new Error('not implemented');
}

/** Human-readable breadcrumb for an element, e.g. "Dashboard → Revenue Card". */
export function buildLabel(el: Element): string {
  throw new Error('not implemented');
}

/** Short technical description for the picker tooltip, e.g. "button.btn-primary". */
export function describeElement(el: Element): string {
  throw new Error('not implemented');
}
