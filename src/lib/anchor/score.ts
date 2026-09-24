import type { DocRect, ElementAnchor } from '../types';
import { hasArea } from './dom';
import { completeFeatures, readFeatures, type CandidateFeatures } from './fingerprint';
import {
  createTextProfile,
  normalizeForCompare,
  profileSimilarity,
  sequenceSimilarity,
  textSimilarity,
  type TextProfile,
} from './similarity';
import { TEST_ID_ATTRIBUTES } from './stability';

/*
 * Scoring model
 * -------------
 * identity  — what the element IS: stable id, test ids, other attributes,
 *             classes, text. Weighted mean over the features either side has.
 * context   — where it IS: ancestor tags, nth-of-type, rect, selector/XPath hit.
 *
 * score = (0.8 * identity + 0.2 * context) * penalty
 *
 * Context is capped at 20% on purpose: when a card is removed its neighbour
 * slides into the same slot, so position alone must never be able to make a
 * look-alike win. Contradictions (different test id, completely different
 * text...) multiply the score down.
 */

const W = {
  id: 6,
  idMissing: 3,
  testId: 6,
  testIdMissing: 3,
  classes: 2.5,
  text: 5,
  textOneSided: 4,
  ancestors: 2,
  nth: 0.75,
  position: 1,
  size: 1,
  hint: 0.75,
} as const;

const ATTRIBUTE_WEIGHTS: Record<string, number> = {
  name: 3,
  'aria-label': 2.5,
  href: 2.5,
  for: 2,
  src: 2,
  alt: 2,
  placeholder: 2,
  title: 1.5,
  role: 1,
  type: 1,
};
/** Human-written values compared by similarity rather than equality. */
const FUZZY_ATTRIBUTES = new Set(['aria-label', 'title', 'alt', 'placeholder']);
/** Both present but different: almost certainly a different element. */
const CONFLICTING_ATTRIBUTES = new Set(['name', 'href', 'for', 'src']);
/** An equal value corroborates identity when the text changed. */
const DISTINCTIVE_ATTRIBUTES = new Set(['name', 'href', 'for', 'src', 'aria-label', 'alt']);

const PENALTY = {
  testIdConflict: 0.2,
  idConflict: 0.35,
  attributeConflict: 0.7,
  textContradiction: 0.5,
  /** Text rewritten but a stable id / test id / distinctive attribute still matches. */
  textContradictionCorroborated: 0.85,
  /** Text changed noticeably with nothing else confirming identity. */
  textDrift: 0.75,
} as const;

const IDENTITY_SHARE = 0.8;
/** Elements with no identifying content can only ever be matched by position; keep them below the accept line. */
const BARE_FACTOR = 0.55;
/** Rank bonus for an exact text match: one exact card among look-alikes must beat its neighbours. */
export const EXACT_TEXT_BONUS = 0.15;
const MIN_EXACT_TEXT = 2;
const TEXT_CONTRADICTION = 0.3;
const MIN_POSITION_SCALE = 150;

export interface PreparedAnchor {
  anchor: ElementAnchor;
  tagName: string;
  id: string | undefined;
  text: TextProfile;
  classes: ReadonlySet<string>;
  attributeNames: ReadonlySet<string>;
  testAttributes: ReadonlyArray<readonly [string, string]>;
  otherAttributes: ReadonlyArray<readonly [string, string]>;
  /** null when the stored anchor lacks the field (unknown, not "no ancestors"). */
  ancestorTags: readonly string[] | null;
  nthOfType: number;
  rect: DocRect | null;
  viewportDiagonal: number;
  /** 0..1 — how much identifying content the anchor carries beyond its position. */
  informativeness: number;
}

export interface ScoreBreakdown {
  /** 0..1 — confidence that this is the anchored element. */
  score: number;
  /** score plus the exact-text bonus; used to rank candidates against each other. */
  rank: number;
  identity: number | null;
  context: number;
  /** Raw text similarity (0..1), null when neither side has text. */
  textSimilarity: number | null;
  exactText: boolean;
  /** Content identical to the anchor (text, id, attributes, classes) with no contradiction. */
  exact: boolean;
  /** A stable id or test attribute matched. */
  strongHook: boolean;
  /** Product of all penalties (1 = none). */
  penalty: number;
  contradictions: string[];
}

export interface ScoreOptions {
  /** Include the selector/XPath-hit feature (only when some candidate was hit). */
  hints?: boolean;
  /** Treat not-yet-computed text/rect as perfect matches: yields an upper bound. */
  optimistic?: boolean;
}

const TEST_IDS = new Set<string>(TEST_ID_ATTRIBUTES);

/** Normalise an anchor once (it may come from storage or an import, so tolerate missing fields). */
export function prepareAnchor(anchor: ElementAnchor): PreparedAnchor {
  const attributes = anchor.attributes ?? {};
  const testAttributes: [string, string][] = [];
  const otherAttributes: [string, string][] = [];
  for (const [name, value] of Object.entries(attributes)) {
    if (typeof value !== 'string' || !value) continue;
    (TEST_IDS.has(name) ? testAttributes : otherAttributes).push([name, value]);
  }
  const text = createTextProfile(normalizeForCompare(typeof anchor.text === 'string' ? anchor.text : ''));
  const classes = new Set(Array.isArray(anchor.classes) ? anchor.classes : []);
  const viewport = anchor.viewport ?? { width: 0, height: 0 };

  let informativeness = 0;
  if (text.text.length >= 3) informativeness += 0.5;
  if (anchor.id || testAttributes.length) informativeness += 0.5;
  if (otherAttributes.some(([name]) => DISTINCTIVE_ATTRIBUTES.has(name))) informativeness += 0.3;
  if (classes.size) informativeness += 0.1;

  return {
    anchor,
    tagName: typeof anchor.tagName === 'string' ? anchor.tagName.toLowerCase() : '',
    id: anchor.id || undefined,
    text,
    classes,
    attributeNames: new Set(Object.keys(attributes)),
    testAttributes,
    otherAttributes,
    ancestorTags: Array.isArray(anchor.ancestorTags) ? anchor.ancestorTags : null,
    nthOfType: typeof anchor.nthOfType === 'number' ? anchor.nthOfType : 1,
    rect: hasArea(anchor.rect) ? anchor.rect : null,
    viewportDiagonal: Math.hypot(viewport.width || 1280, viewport.height || 800),
    informativeness: Math.min(1, informativeness),
  };
}

interface Tally {
  sum: number;
  weight: number;
}

function add(tally: Tally, weight: number, similarity: number): void {
  tally.sum += weight * similarity;
  tally.weight += weight;
}

function meanOf(tally: Tally): number | null {
  return tally.weight > 0 ? tally.sum / tally.weight : null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Longer texts drift more between renders (dynamic snippets), so tolerate more change. */
function driftThreshold(length: number): number {
  return length > 40 ? 0.6 : 0.75;
}

function positionSimilarity(p: PreparedAnchor, anchorRect: DocRect, rect: DocRect): number {
  const dx = anchorRect.x + anchorRect.width / 2 - (rect.x + rect.width / 2);
  const dy = anchorRect.y + anchorRect.height / 2 - (rect.y + rect.height / 2);
  const scale = Math.max(MIN_POSITION_SCALE, p.viewportDiagonal * 0.25);
  return Math.exp(-Math.hypot(dx, dy) / scale);
}

function sizeSimilarity(a: DocRect, b: DocRect): number {
  const widths = Math.min(a.width, b.width) / Math.max(a.width, b.width);
  const heights = Math.min(a.height, b.height) / Math.max(a.height, b.height);
  return Math.sqrt(widths * heights);
}

function emptyBreakdown(contradiction: string): ScoreBreakdown {
  return {
    score: 0,
    rank: 0,
    identity: 0,
    context: 0,
    textSimilarity: null,
    exactText: false,
    exact: false,
    strongHook: false,
    penalty: 0,
    contradictions: [contradiction],
  };
}

/** Pure scoring of one candidate's features against a prepared anchor. */
export function scoreFeatures(p: PreparedAnchor, f: CandidateFeatures, options: ScoreOptions = {}): ScoreBreakdown {
  if (f.tag !== p.tagName) return emptyBreakdown('tag');

  const identity: Tally = { sum: 0, weight: 0 };
  const context: Tally = { sum: 0, weight: 0 };
  const contradictions: string[] = [];
  let penalty = 1;
  let strongHook = false;
  let corroborated = false;
  let attributesEqual = true;

  if (p.id) {
    if (f.id === p.id) {
      add(identity, W.id, 1);
      strongHook = true;
    } else if (f.id) {
      add(identity, W.id, 0);
      penalty *= PENALTY.idConflict;
      contradictions.push('id');
    } else {
      add(identity, W.idMissing, 0);
    }
  }

  for (const [name, value] of p.testAttributes) {
    const other = f.attributes[name];
    if (other === value) {
      add(identity, W.testId, 1);
      strongHook = true;
      continue;
    }
    attributesEqual = false;
    if (other === undefined) {
      add(identity, W.testIdMissing, 0);
    } else {
      add(identity, W.testId, 0);
      penalty *= PENALTY.testIdConflict;
      contradictions.push(name);
    }
  }

  for (const [name, value] of p.otherAttributes) {
    const weight = ATTRIBUTE_WEIGHTS[name] ?? 1;
    const other = f.attributes[name];
    if (other === value) {
      add(identity, weight, 1);
      if (DISTINCTIVE_ATTRIBUTES.has(name)) corroborated = true;
      continue;
    }
    attributesEqual = false;
    if (other === undefined) {
      add(identity, weight * 0.5, 0);
    } else if (FUZZY_ATTRIBUTES.has(name)) {
      const similarity = textSimilarity(value, other);
      add(identity, weight, similarity);
      if (similarity < TEXT_CONTRADICTION && Math.min(value.length, other.length) >= 4) {
        penalty *= PENALTY.attributeConflict;
        contradictions.push(name);
      }
    } else {
      add(identity, weight, 0);
      if (CONFLICTING_ATTRIBUTES.has(name)) {
        penalty *= PENALTY.attributeConflict;
        contradictions.push(name);
      }
    }
  }
  // Attributes the element gained since capture: weak evidence against.
  for (const name of Object.keys(f.attributes)) {
    if (!p.attributeNames.has(name)) add(identity, Math.min(ATTRIBUTE_WEIGHTS[name] ?? 1, 2) * 0.25, 0);
  }

  let classScore: number | null = null;
  if (p.classes.size && f.classes.length) {
    let shared = 0;
    for (const name of f.classes) if (p.classes.has(name)) shared++;
    const jaccard = shared / (p.classes.size + f.classes.length - shared);
    const recall = shared / p.classes.size;
    classScore = (jaccard + recall) / 2;
    add(identity, W.classes, classScore);
  } else if (p.classes.size || f.classes.length) {
    // One side has no stable classes at all: typical of a switch to hashed
    // CSS-in-JS names, so weaker evidence than two disjoint class lists.
    classScore = 0;
    add(identity, W.classes / 2, 0);
  }

  const anchorText = p.text.text;
  let textSim: number | null = null;
  let textEqual = true;
  let exactText = false;
  if (f.text === undefined) {
    // Upper bound: assume the text will match exactly.
    if (anchorText) {
      add(identity, W.text, 1);
      exactText = anchorText.length >= MIN_EXACT_TEXT;
    }
  } else if (anchorText && f.text) {
    textEqual = anchorText === f.text;
    textSim = textEqual ? 1 : profileSimilarity(p.text, f.text);
    exactText = textEqual && anchorText.length >= MIN_EXACT_TEXT;
    // Squared: near-identical list items ("Product 7" vs "Product 17") must fall well below an exact match.
    add(identity, W.text, textSim * textSim);
    if (!textEqual && Math.min(anchorText.length, f.text.length) >= 4) {
      const confirmed = strongHook || corroborated;
      if (textSim < TEXT_CONTRADICTION) {
        penalty *= confirmed ? PENALTY.textContradictionCorroborated : PENALTY.textContradiction;
        contradictions.push('text');
      } else if (!confirmed && textSim < driftThreshold(anchorText.length)) {
        penalty *= PENALTY.textDrift;
      }
    }
  } else if (anchorText || f.text) {
    textEqual = false;
    textSim = 0;
    add(identity, W.textOneSided, 0);
  }

  if (p.ancestorTags) add(context, W.ancestors, sequenceSimilarity(p.ancestorTags, f.ancestorTags));
  add(context, W.nth, 1 / (1 + Math.abs(p.nthOfType - f.nthOfType)));
  if (p.rect) {
    if (f.rect === undefined) {
      if (options.optimistic) {
        add(context, W.position, 1);
        add(context, W.size, 1);
      }
    } else if (hasArea(f.rect)) {
      add(context, W.position, positionSimilarity(p, p.rect, f.rect));
      add(context, W.size, sizeSimilarity(p.rect, f.rect));
    }
  }
  if (options.hints) add(context, W.hint, f.hint ? 1 : 0);

  const identityMean = meanOf(identity);
  const contextMean = meanOf(context) ?? 0;
  const base =
    identityMean === null
      ? BARE_FACTOR * contextMean
      : IDENTITY_SHARE * identityMean + (1 - IDENTITY_SHARE) * contextMean;
  const score = clamp01(base * penalty);
  const exact =
    !options.optimistic &&
    penalty === 1 &&
    textEqual &&
    (!p.id || f.id === p.id) &&
    attributesEqual &&
    (p.classes.size === 0 || (classScore ?? 0) >= 0.5);

  return {
    score,
    rank: score + (exactText ? EXACT_TEXT_BONUS * penalty : 0),
    identity: identityMean,
    context: contextMean,
    textSimilarity: textSim,
    exactText,
    exact,
    strongHook,
    penalty,
    contradictions,
  };
}

/** Score how likely `el` is the element `anchor` was captured from (0..1, see ScoreBreakdown). */
export function scoreCandidate(anchor: ElementAnchor, el: Element): ScoreBreakdown {
  const prepared = prepareAnchor(anchor);
  const features = readFeatures(el);
  completeFeatures(features, prepared.rect !== null);
  return scoreFeatures(prepared, features);
}
