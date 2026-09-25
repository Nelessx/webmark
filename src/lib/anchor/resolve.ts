import { isWebmarkNode } from '../constants';
import type { ElementAnchor } from '../types';
import { countMatches, cssEscape, tagOf } from './dom';
import { completeFeatures, readFeatures, type CandidateFeatures } from './fingerprint';
import { countLookAlikes, insideAny, sameTagElements, webmarkHosts } from './peers';
import {
  completeCandidate,
  prepareAnchor,
  scoreFeatures,
  type PreparedAnchor,
  type ScoreBreakdown,
  type ScoreOptions,
} from './score';
import { normalizeForCompare, textShape } from './similarity';
import { elementText } from './text';
import { evaluateXPath } from './xpath';

export interface ResolveResult {
  element: Element;
  /** 0..1 — how sure we are this is the same element. */
  confidence: number;
  method: 'selector' | 'xpath' | 'fuzzy';
}

/** Minimum score for a fuzzy match, and the least confidence worth showing a note for. */
export const ACCEPT_SCORE = 0.65;
/** The winner must beat the runner-up by this much; otherwise it's ambiguous and we return null. */
export const AMBIGUITY_MARGIN = 0.1;
/** Same-tag elements considered before falling back to candidates sharing a class/attribute. */
const MAX_CANDIDATES = 12000;
/** A direct hit on a stable id / test id survives this much penalty (e.g. its text was rewritten). */
const HOOK_MIN_PENALTY = 0.8;
const MAX_FUZZY_CONFIDENCE = 0.95;
const CONFIRMED_CONFIDENCE = 0.9;
/** Identical content at the stored position, with nothing else on the page looking the same. */
const UNIQUE_POSITION_CONFIDENCE = 0.7;
const POSITIONAL_SELECTOR = /:nth-(?:of-type|child)\(/;

type Method = ResolveResult['method'];
/** A direct hit resolves the anchor, is rejected (try the next strategy), or shows that it can't be resolved. */
type Verdict = ResolveResult | 'reject' | 'ambiguous';

interface Scored {
  features: CandidateFeatures;
  breakdown: ScoreBreakdown;
}

/**
 * Find the element an anchor refers to, or null if nothing is convincing.
 *
 * 1. The stored selector, then the XPath — accepted only when the element's
 *    fingerprint confirms it. A position (nth-of-type, XPath index) may now
 *    hold a look-alike, so identical content found there must also be unique
 *    on the page or sit in the anchor's recorded item (card, row).
 * 2. Fuzzy search over same-tag elements, accepted only when the best
 *    candidate clears ACCEPT_SCORE and beats the runner-up by AMBIGUITY_MARGIN.
 *    An orphaned note is acceptable; a note on the wrong element is not.
 */
export function resolveAnchor(anchor: ElementAnchor, doc: Document = document): ResolveResult | null {
  const prepared = prepareAnchor(anchor);
  if (!prepared.tagName) return null;

  const selectorHit = findBySelector(prepared, doc);
  if (selectorHit) {
    const verdict = verifyDirectHit(prepared, selectorHit, 'selector', doc);
    if (verdict === 'ambiguous') return null;
    if (verdict !== 'reject') return verdict;
  }
  const xpathHit = findByXPath(prepared, doc);
  if (xpathHit && xpathHit !== selectorHit) {
    const verdict = verifyDirectHit(prepared, xpathHit, 'xpath', doc);
    if (verdict === 'ambiguous') return null;
    if (verdict !== 'reject') return verdict;
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

function result(element: Element, confidence: number, method: Method): ResolveResult {
  return { element, confidence: round(confidence), method };
}

/** The matched hook was unique when captured and still is, so it really identifies `el`. */
function hookIsUnique(p: PreparedAnchor, el: Element, doc: Document): boolean {
  if (p.id && p.strongHooks.has('id') && el.getAttribute('id') === p.id && countMatches(doc, `#${cssEscape(p.id)}`) === 1) {
    return true;
  }
  return p.testAttributes.some(
    ([name, value]) =>
      p.strongHooks.has(name) &&
      el.getAttribute(name) === value &&
      countMatches(doc, `[${name}="${cssEscape(value)}"]`) === 1,
  );
}

/**
 * Whether identical content found at the stored position is the anchored
 * element. A recorded item has already confirmed or contradicted it by now;
 * this covers anchors without one.
 */
function positionHolds(p: PreparedAnchor, doc: Document): boolean {
  if (p.lookAlikes === 0) return true;
  // Look-alikes that nothing but their position tells apart: trust the
  // position only while every one of them is still on the page.
  if (p.lookAlikes !== undefined) return countLookAlikes(p, doc, p.lookAlikes + 2) === p.lookAlikes + 1;
  // Stored before look-alikes were recorded: trust it only if nothing else looks the same.
  return countLookAlikes(p, doc, 2) <= 1;
}

function verifyDirectHit(p: PreparedAnchor, el: Element, method: Method, doc: Document): Verdict {
  const positional = method === 'xpath' || POSITIONAL_SELECTOR.test(p.anchor.selector);
  const features = readFeatures(el);
  // A selector without positions was unique by structure when captured, so no
  // look-alike can have slid into it: only a position needs the item's word.
  if (positional) completeCandidate(p, features);
  else completeFeatures(features, p.rect !== null);
  const breakdown = scoreFeatures(p, features);

  if (breakdown.strongHook && breakdown.penalty >= HOOK_MIN_PENALTY && hookIsUnique(p, el, doc)) {
    return result(el, Math.max(CONFIRMED_CONFIDENCE, breakdown.score), method);
  }
  if (!breakdown.exact) return 'reject';
  if (!positional || breakdown.itemConfirmed) {
    return result(el, Math.max(CONFIRMED_CONFIDENCE, breakdown.score), method);
  }
  // Identical content at the same position, but lists shift and sort: a
  // look-alike may have slid into this slot.
  if (!positionHolds(p, doc)) return p.lookAlikes === undefined ? 'ambiguous' : 'reject';
  return result(el, Math.min(MAX_FUZZY_CONFIDENCE, UNIQUE_POSITION_CONFIDENCE + 0.25 * p.informativeness), method);
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
  const hosts = webmarkHosts(doc);
  const seenPerParent = new Map<Node | null, number>();
  const out: Candidate[] = [];
  for (const el of sameTagElements(doc, p.tagName)) {
    const nthOfType = (seenPerParent.get(el.parentNode) ?? 0) + 1;
    seenPerParent.set(el.parentNode, nthOfType);
    if (hosts.length && insideAny(el, hosts)) continue;
    out.push({ element: el, nthOfType });
  }
  if (out.length <= MAX_CANDIDATES) return out;
  const related = out.filter((candidate) => sharesIdentity(p, candidate.element));
  // Still too many to rank reliably: better an orphaned note than a guess.
  return related.length <= MAX_CANDIDATES ? related : [];
}

/**
 * Anchors stored before numbers were classified: numbers may change (a live
 * KPI) only while no other candidate reads like the anchor up to its numbers;
 * otherwise they tell look-alikes apart ("Order #1001" / "Order #1003").
 * Decided lazily (it reads every candidate's text) and at most once.
 */
function pageNumbersPolicy(p: PreparedAnchor, staged: readonly { features: CandidateFeatures }[]): (() => boolean) | undefined {
  if (p.numbersMayChange !== undefined || !p.text.hasDigits) return undefined;
  let decided: boolean | undefined;
  return () => {
    if (decided !== undefined) return decided;
    let sameShape = 0;
    for (const { features } of staged) {
      features.text ??= normalizeForCompare(elementText(features.element));
      if (/\d/.test(features.text) && textShape(features.text) === p.text.shape && ++sameShape > 1) break;
    }
    decided = sameShape <= 1;
    return decided;
  };
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
  const options: ScoreOptions = { hints, numbersMayChange: pageNumbersPolicy(p, staged) };

  // Pass 2: read text/rect in bound order until nothing left can change the
  // outcome. Text is the expensive part, and on pages without an exact
  // look-alike most candidates are skipped here.
  let best: Scored | null = null;
  let second: Scored | null = null;
  for (const { features, bound } of staged) {
    if (second && bound <= second.breakdown.rank) break;
    if (best && bound <= best.breakdown.rank - AMBIGUITY_MARGIN) break;
    if (bound < ACCEPT_SCORE && (!best || best.breakdown.score < ACCEPT_SCORE)) break;
    completeCandidate(p, features);
    const scored: Scored = { features, breakdown: scoreFeatures(p, features, options) };
    if (!best || scored.breakdown.rank > best.breakdown.rank) {
      second = best;
      best = scored;
    } else if (!second || scored.breakdown.rank > second.breakdown.rank) {
      second = scored;
    }
  }

  if (!best || best.breakdown.score < ACCEPT_SCORE) return null;
  if (second && best.breakdown.rank - second.breakdown.rank < AMBIGUITY_MARGIN) return null;
  // One of several identical elements that only their position told apart,
  // and the position is gone: it may be any of them.
  if (p.lookAlikes && !p.item && best.features.text === p.text.text) return null;
  if (isWebmarkNode(best.features.element)) return null;
  return {
    element: best.features.element,
    confidence: round(Math.min(MAX_FUZZY_CONFIDENCE, best.breakdown.score)),
    method: 'fuzzy',
  };
}
