import { WEBMARK_HOST_TAG, isWebmarkNode } from '../constants';
import type { ElementAnchor } from '../types';
import { cssEscape, tagOf } from './dom';
import { completeFeatures, readFeatures, type CandidateFeatures } from './fingerprint';
import { prepareAnchor, scoreFeatures, type PreparedAnchor, type ScoreBreakdown } from './score';
import { evaluateXPath } from './xpath';

export interface ResolveResult {
  element: Element;
  /** 0..1 — how sure we are this is the same element. */
  confidence: number;
  method: 'selector' | 'xpath' | 'fuzzy';
}

/** Minimum score for a fuzzy match. */
export const ACCEPT_SCORE = 0.65;
/** The winner must beat the runner-up by this much; otherwise it's ambiguous and we return null. */
export const AMBIGUITY_MARGIN = 0.1;
/** Same-tag elements considered before falling back to candidates sharing a class/attribute. */
const MAX_CANDIDATES = 12000;
/** A direct hit on a stable id / test id survives this much penalty (e.g. its text was rewritten). */
const HOOK_MIN_PENALTY = 0.8;
const MAX_FUZZY_CONFIDENCE = 0.95;
const POSITIONAL_SELECTOR = /:nth-(?:of-type|child)\(/;

type Method = ResolveResult['method'];

interface Scored {
  features: CandidateFeatures;
  breakdown: ScoreBreakdown;
}

/**
 * Find the element an anchor refers to, or null if nothing is convincing.
 *
 * 1. The stored selector, then the XPath — accepted only when the element's
 *    fingerprint confirms it (a positional selector may now point at the
 *    neighbouring card).
 * 2. Fuzzy search over same-tag elements, accepted only when the best
 *    candidate clears ACCEPT_SCORE and beats the runner-up by AMBIGUITY_MARGIN.
 *    An orphaned note is acceptable; a note on the wrong element is not.
 */
export function resolveAnchor(anchor: ElementAnchor, doc: Document = document): ResolveResult | null {
  const prepared = prepareAnchor(anchor);
  if (!prepared.tagName) return null;

  const selectorHit = findBySelector(prepared, doc);
  if (selectorHit) {
    const direct = verifyDirectHit(prepared, selectorHit, 'selector', doc);
    if (direct) return direct;
  }
  const xpathHit = findByXPath(prepared, doc);
  if (xpathHit && xpathHit !== selectorHit) {
    const direct = verifyDirectHit(prepared, xpathHit, 'xpath', doc);
    if (direct) return direct;
  }
  return fuzzyResolve(prepared, doc, [selectorHit, xpathHit]);
}

function isPlausibleHit(p: PreparedAnchor, el: Element | null): el is Element {
  return !!el && el.isConnected && tagOf(el) === p.tagName && !isWebmarkNode(el);
}

function findBySelector(p: PreparedAnchor, doc: Document): Element | null {
  if (!p.anchor.selector) return null;
  try {
    const found = doc.querySelectorAll(p.anchor.selector);
    const el = found.length === 1 ? found[0] ?? null : null;
    return isPlausibleHit(p, el) ? el : null;
  } catch {
    return null;
  }
}

function findByXPath(p: PreparedAnchor, doc: Document): Element | null {
  const el = evaluateXPath(p.anchor.xpath, doc);
  return isPlausibleHit(p, el) ? el : null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function countMatches(doc: Document, selector: string): number {
  try {
    return doc.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

/** The matched stable id / test attribute is unique in the document, so it really identifies `el`. */
function hookIsUnique(p: PreparedAnchor, el: Element, doc: Document): boolean {
  if (p.id && el.getAttribute('id') === p.id && countMatches(doc, `#${cssEscape(p.id)}`) === 1) return true;
  return p.testAttributes.some(
    ([name, value]) =>
      el.getAttribute(name) === value && countMatches(doc, `[${name}="${cssEscape(value)}"]`) === 1,
  );
}

function verifyDirectHit(p: PreparedAnchor, el: Element, method: Method, doc: Document): ResolveResult | null {
  const features = readFeatures(el);
  completeFeatures(features, p.rect !== null);
  const breakdown = scoreFeatures(p, features);

  if (breakdown.strongHook && breakdown.penalty >= HOOK_MIN_PENALTY && hookIsUnique(p, el, doc)) {
    return { element: el, confidence: round(Math.max(0.9, breakdown.score)), method };
  }
  if (!breakdown.exact) return null;
  // Identical content at the same position. With a positional selector or an
  // XPath the list may have shifted under us, so confidence depends on how
  // much identifying content the anchor has.
  const positional = method === 'xpath' || POSITIONAL_SELECTOR.test(p.anchor.selector);
  const confidence = positional
    ? Math.min(MAX_FUZZY_CONFIDENCE, 0.55 + 0.4 * p.informativeness)
    : Math.max(0.9, breakdown.score);
  return { element: el, confidence: round(confidence), method };
}

function insideWebmarkHost(el: Element, hosts: readonly Element[]): boolean {
  return hosts.some((host) => host.contains(el));
}

/** Cheap check used to thin out enormous candidate lists. */
function sharesIdentity(p: PreparedAnchor, el: Element): boolean {
  if (p.id && el.getAttribute('id') === p.id) return true;
  for (const [name, value] of [...p.testAttributes, ...p.otherAttributes]) {
    if (el.getAttribute(name) === value) return true;
  }
  const classes = el.getAttribute('class');
  return !!classes && classes.split(/\s+/).some((name) => p.classes.has(name));
}

interface Candidate {
  element: Element;
  nthOfType: number;
}

/**
 * Same-tag elements outside WebMark's UI, with their nth-of-type. Every
 * same-tag sibling of a candidate is itself a candidate and they arrive in
 * document order, so one pass counting per parent gives nth-of-type in O(n)
 * (walking previous siblings per candidate is quadratic on long flat lists).
 */
function collectCandidates(p: PreparedAnchor, doc: Document): Candidate[] {
  let source: ArrayLike<Element> = doc.getElementsByTagName(p.tagName);
  // Read `length` once: on a live collection some engines (jsdom) recount on every access.
  let count = source.length;
  if (count === 0) {
    // Mixed-case SVG names ("linearGradient") are not found by a lower-case tag lookup.
    source = Array.from(doc.querySelectorAll('*')).filter((el) => tagOf(el) === p.tagName);
    count = source.length;
  }
  const hosts = Array.from(doc.querySelectorAll(WEBMARK_HOST_TAG));
  const seenPerParent = new Map<Node | null, number>();
  const out: Candidate[] = [];
  for (let i = 0; i < count; i++) {
    const el = source[i];
    if (!el) continue;
    const nthOfType = (seenPerParent.get(el.parentNode) ?? 0) + 1;
    seenPerParent.set(el.parentNode, nthOfType);
    if (hosts.length && insideWebmarkHost(el, hosts)) continue;
    out.push({ element: el, nthOfType });
  }
  if (out.length <= MAX_CANDIDATES) return out;
  const related = out.filter((candidate) => sharesIdentity(p, candidate.element));
  // Still too many to rank reliably: better an orphaned note than a guess.
  return related.length <= MAX_CANDIDATES ? related : [];
}

function fuzzyResolve(p: PreparedAnchor, doc: Document, hitList: (Element | null)[]): ResolveResult | null {
  const hits = new Set(hitList.filter((el): el is Element => el !== null));
  const hints = hits.size > 0;
  const candidates = collectCandidates(p, doc);
  if (!candidates.length) return null;

  // Pass 1: cheap features for everyone, giving an upper bound on each rank.
  const staged = candidates.map(({ element, nthOfType }) => {
    const features = readFeatures(element, nthOfType);
    features.hint = hits.has(element);
    return { features, bound: scoreFeatures(p, features, { hints, optimistic: true }).rank };
  });
  staged.sort((a, b) => b.bound - a.bound);

  // Pass 2: read text/rect in bound order until nothing left can change the
  // outcome. Text is the expensive part, and on pages without an exact
  // look-alike most candidates are skipped here.
  let best: Scored | null = null;
  let second: Scored | null = null;
  for (const { features, bound } of staged) {
    if (second && bound <= second.breakdown.rank) break;
    if (best && bound <= best.breakdown.rank - AMBIGUITY_MARGIN) break;
    if (bound < ACCEPT_SCORE && (!best || best.breakdown.score < ACCEPT_SCORE)) break;
    completeFeatures(features, p.rect !== null);
    const scored: Scored = { features, breakdown: scoreFeatures(p, features, { hints }) };
    if (!best || scored.breakdown.rank > best.breakdown.rank) {
      second = best;
      best = scored;
    } else if (!second || scored.breakdown.rank > second.breakdown.rank) {
      second = scored;
    }
  }

  if (!best || best.breakdown.score < ACCEPT_SCORE) return null;
  if (second && best.breakdown.rank - second.breakdown.rank < AMBIGUITY_MARGIN) return null;
  return {
    element: best.features.element,
    confidence: round(Math.min(MAX_FUZZY_CONFIDENCE, best.breakdown.score)),
    method: 'fuzzy',
  };
}
