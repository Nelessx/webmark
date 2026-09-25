/** Lower-cased, whitespace-collapsed form used for all text comparisons. */
export function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

const NUMBER = /\d+(?:[.,:]\d+)*/g;

/** Text with every number replaced by "#": "Revenue $12,340" and "Revenue $13,020" share a shape. */
export function textShape(value: string): string {
  return value.replace(NUMBER, '#');
}

/** The numbers in `value`, in order, as one comparable string. */
export function numbersOf(value: string): string {
  return (value.match(NUMBER) ?? []).join(' ');
}

/**
 * Texts that differ only in their numbers (live counters, prices, dates) score
 * this much. High enough to follow a KPI card whose value changed, low enough
 * that an exact match among look-alike list items still stands out.
 */
export const NUMBERS_ONLY_SIMILARITY = 0.9;

/** Precomputed bigrams of the anchor text, reused against every candidate. */
export interface TextProfile {
  text: string;
  bigrams: Map<number, number>;
  bigramCount: number;
  hasDigits: boolean;
  /** See numbersOf(). */
  numbers: string;
  shape: string;
  shapeBigrams: Map<number, number>;
  shapeBigramCount: number;
}

function bigramsOf(value: string): Map<number, number> {
  const counts = new Map<number, number>();
  for (let i = 0; i < value.length - 1; i++) {
    const code = value.charCodeAt(i) * 65536 + value.charCodeAt(i + 1);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return counts;
}

/** `text` must already be normalised (see normalizeForCompare). */
export function createTextProfile(text: string): TextProfile {
  const hasDigits = /\d/.test(text);
  const shape = hasDigits ? textShape(text) : text;
  return {
    text,
    bigrams: bigramsOf(text),
    bigramCount: Math.max(0, text.length - 1),
    hasDigits,
    numbers: hasDigits ? numbersOf(text) : '',
    shape,
    shapeBigrams: hasDigits ? bigramsOf(shape) : new Map(),
    shapeBigramCount: Math.max(0, shape.length - 1),
  };
}

// Reused between calls: resolving scores thousands of candidates per pass.
const scratch = new Map<number, number>();

/** Sørensen–Dice coefficient over character bigrams (multiset). */
function diceAgainst(counts: Map<number, number>, total: number, other: string): number {
  const otherTotal = other.length - 1;
  if (total <= 0 || otherTotal <= 0) return 0;
  scratch.clear();
  let shared = 0;
  for (let i = 0; i < otherTotal; i++) {
    const code = other.charCodeAt(i) * 65536 + other.charCodeAt(i + 1);
    const available = counts.get(code);
    if (!available) continue;
    const used = scratch.get(code) ?? 0;
    if (used < available) {
      shared++;
      scratch.set(code, used + 1);
    }
  }
  return (2 * shared) / (total + otherTotal);
}

const ALWAYS = () => true;

/**
 * Similarity 0..1 between the profiled text and `other` (normalised). Empty
 * never matches non-empty. `numbersMayChange` is consulted (lazily, it may be
 * costly) before crediting texts that differ only in their numbers: in a list
 * of "Order #1001" / "Order #1002" the numbers are the identity.
 */
export function profileSimilarity(profile: TextProfile, other: string, numbersMayChange: () => boolean = ALWAYS): number {
  if (profile.text === other) return 1;
  if (!profile.text || !other) return 0;
  let similarity = diceAgainst(profile.bigrams, profile.bigramCount, other);
  if (profile.hasDigits && similarity < NUMBERS_ONLY_SIMILARITY && /\d/.test(other) && numbersMayChange()) {
    const shape = textShape(other);
    const shapeSimilarity =
      shape === profile.shape ? 1 : diceAgainst(profile.shapeBigrams, profile.shapeBigramCount, shape);
    similarity = Math.max(similarity, NUMBERS_ONLY_SIMILARITY * shapeSimilarity);
  }
  return similarity;
}

/** Convenience wrapper for one-off comparisons. */
export function textSimilarity(a: string, b: string): number {
  return profileSimilarity(createTextProfile(normalizeForCompare(a)), normalizeForCompare(b));
}

/** Longest-common-subsequence ratio: tolerant to one wrapper added or removed. */
export function sequenceSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === b.length && a.every((value, i) => value === b[i])) return 1;
  if (!a.length || !b.length) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? (previous[j - 1] ?? 0) + 1 : Math.max(previous[j] ?? 0, current[j - 1] ?? 0);
    }
    [previous, current] = [current, previous];
  }
  return (previous[b.length] ?? 0) / Math.max(a.length, b.length);
}
