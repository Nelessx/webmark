import type { AnchorItem } from '../types';
import { ancestorAt, countMatches, cssEscape, isDocumentLevel, isInsideEditable } from './dom';
import { normalizeForCompare, textShape } from './similarity';
import { TEST_ID_ATTRIBUTES } from './stability';
import { readText } from './text';

/*
 * An element's "item" is the smallest ancestor whose content tells it apart
 * from its look-alikes: the product card around an "Add to cart" button, the
 * table row around an "Edit" link. Repeated controls are among the most
 * annotated things on a page, and their own content says nothing about which
 * card they belong to, so a position that now holds a look-alike must be
 * confirmed by the item.
 */

/** Deep enough for a button in a card footer, inside a card, inside a grid cell. */
export const MAX_ITEM_DEPTH = 8;
/** Stored item text, cut at a word boundary. */
const ITEM_TEXT_MAX = 120;
/** Text read to measure an item: enough to tell a card from the list around it. */
export const ITEM_LENGTH_CAP = 2000;
const MIN_LENGTH_SLACK = 16;
const LENGTH_SLACK = 0.25;

/** A stored item, validated (it may come from storage or an import). */
export interface PreparedItem {
  depth: number;
  text: string;
  shape: string;
  /** Word count of `text`, to compare the same prefix of a longer text. */
  words: number;
  length: number;
  /** `text` is only the start of the item's text. */
  truncated: boolean;
  shapeUnique: boolean;
  testId: readonly [string, string] | null;
}

/**
 * Normalised text of a (possible) item, cut at `max` (≤ ITEM_LENGTH_CAP).
 * Never read inside editable regions: that is what the user typed. A caller
 * that knows `el` isn't inside one (it contains an element that isn't) may
 * skip that check.
 */
export function itemText(el: Element, max = ITEM_LENGTH_CAP, mayBeEditable = true): string {
  if (mayBeEditable && isInsideEditable(el)) return '';
  return normalizeForCompare(readText(el, Math.min(max, ITEM_LENGTH_CAP)));
}

function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return space > max / 2 ? cut.slice(0, space) : cut;
}

function wordCount(text: string): number {
  return text ? text.split(' ').length : 0;
}

/** The first `count` words of `text`. */
function leadingWords(text: string, count: number): string {
  let end = -1;
  for (let i = 0; i < count; i++) {
    end = text.indexOf(' ', end + 1);
    if (end === -1) return text;
  }
  return text.slice(0, end);
}

/**
 * How many levels el can climb before an ancestor contains one of
 * `lookAlikes` (an item holding two look-alikes can't tell them apart).
 */
function climbLimit(el: Element, lookAlikes: readonly Element[]): number {
  const depthOf = new Map<Element, number>();
  let depth = 0;
  for (let current = el.parentElement; current && depth <= MAX_ITEM_DEPTH; current = current.parentElement) {
    depthOf.set(current, ++depth);
  }
  let limit = MAX_ITEM_DEPTH;
  for (const other of lookAlikes) {
    for (let current = other.parentElement; current; current = current.parentElement) {
      const shared = depthOf.get(current);
      if (shared === undefined) continue;
      limit = Math.min(limit, shared - 1);
      break;
    }
    if (limit === 0) break;
  }
  return limit;
}

function uniqueTestId(el: Element): AnchorItem['testId'] {
  for (const name of TEST_ID_ATTRIBUTES) {
    const value = el.getAttribute(name)?.trim();
    if (value && value.length <= 200 && countMatches(el.ownerDocument, `[${name}="${cssEscape(value)}"]`) === 1) {
      return { name, value };
    }
  }
  return undefined;
}

/**
 * The item that tells `el` apart from `lookAlikes`, or undefined when none
 * does below their common container (they differ only by position).
 * `ownText` is el's normalised anchor text.
 */
export function captureItem(el: Element, ownText: string, lookAlikes: readonly Element[]): AnchorItem | undefined {
  if (!lookAlikes.length) return undefined;
  const limit = climbLimit(el, lookAlikes);
  let ancestor: Element | null = el;
  for (let depth = 1; depth <= limit; depth++) {
    ancestor = ancestor?.parentElement ?? null;
    if (!ancestor || isDocumentLevel(ancestor)) return undefined;
    const full = itemText(ancestor);
    // A wrapper that adds no text can't tell anything apart.
    if (!full || full === ownText) continue;
    const text = cutAtWord(full, ITEM_TEXT_MAX);
    const shape = textShape(text);
    let distinct = true;
    let shapeUnique = true;
    for (const other of lookAlikes) {
      const peer = ancestorAt(other, depth);
      if (!peer) continue;
      const peerText = cutAtWord(itemText(peer), ITEM_TEXT_MAX);
      if (peerText === text) {
        distinct = false;
        break;
      }
      if (shapeUnique && textShape(peerText) === shape) shapeUnique = false;
    }
    if (!distinct) continue;
    const item: AnchorItem = { depth, text, length: full.length, shapeUnique };
    const testId = uniqueTestId(ancestor);
    if (testId) item.testId = testId;
    return item;
  }
  return undefined;
}

/** Validate a stored item; null when it is missing or unusable. */
export function prepareItem(raw: unknown): PreparedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Partial<AnchorItem>;
  if (typeof item.depth !== 'number' || !(item.depth >= 1) || typeof item.text !== 'string') return null;
  const hook = item.testId;
  const testId =
    hook && typeof hook.value === 'string' && hook.value && (TEST_ID_ATTRIBUTES as readonly string[]).includes(hook.name)
      ? ([hook.name, hook.value] as const)
      : null;
  if (!item.text && !testId) return null;
  const length = typeof item.length === 'number' && item.length >= item.text.length ? item.length : item.text.length;
  return {
    depth: Math.min(Math.floor(item.depth), MAX_ITEM_DEPTH),
    text: item.text,
    shape: textShape(item.text),
    words: wordCount(item.text),
    length,
    truncated: length > item.text.length,
    shapeUnique: item.shapeUnique === true,
    testId,
  };
}

function lengthSlack(item: PreparedItem): number {
  return Math.max(MIN_LENGTH_SLACK, Math.min(item.length, ITEM_LENGTH_CAP) * LENGTH_SLACK);
}

function similarLength(item: PreparedItem, length: number): boolean {
  return Math.abs(Math.min(length, ITEM_LENGTH_CAP) - Math.min(item.length, ITEM_LENGTH_CAP)) <= lengthSlack(item);
}

function isItem(item: PreparedItem, ancestor: Element, mayBeEditable: boolean): boolean {
  if (item.testId) {
    const value = ancestor.getAttribute(item.testId[0]);
    // A different test id is a different item, whatever its text says.
    if (value !== null) return value.trim() === item.testId[1];
  }
  // Reading just past the longest acceptable length (a trailing space may be
  // trimmed) rejects a big container, like the list around the item, without
  // reading it all.
  const full = itemText(ancestor, Math.floor(item.length + lengthSlack(item)) + 2, mayBeEditable);
  // The length tells the item from a bigger container that starts with the same text.
  if (!similarLength(item, full.length)) return false;
  const text = item.truncated ? leadingWords(full, item.words) : full;
  if (text === item.text) return true;
  // Numbers in the item (a price, a stock count) may change when they didn't tell look-alikes apart.
  return item.shapeUnique && textShape(text) === item.shape;
}

/** The ancestor of `el` that is the recorded item: at the recorded depth, or one wrapper less or more. */
export function findItemAncestor(item: PreparedItem, el: Element): Element | null {
  const ancestors: Element[] = [];
  for (let current = el.parentElement; current && ancestors.length <= item.depth; current = current.parentElement) {
    if (isDocumentLevel(current)) break;
    ancestors.push(current);
  }
  // No ancestor of an element outside editable regions is inside one.
  const mayBeEditable = isInsideEditable(el);
  for (const depth of [item.depth, item.depth - 1, item.depth + 1]) {
    const ancestor = depth >= 1 ? ancestors[depth - 1] : undefined;
    if (ancestor && isItem(item, ancestor, mayBeEditable)) return ancestor;
  }
  return null;
}
