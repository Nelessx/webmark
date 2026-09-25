import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/*
 * Keyboard focus in a list of note cards. Changing a note can take its card
 * out of the list (archived under "All", moved out of the chosen status,
 * deleted) or move it (sorted by priority). The browser then drops focus to
 * the page body, and a keyboard user has to start over from the top.
 */

/** Names a control of a note card, so focus can move to the same control on the card that takes its place. */
export const CARD_CONTROL = 'data-card-control';

/** Where focus goes when it is lost outside the cards: this control of this card (or of the card in its place). */
export interface FocusHome {
  cardId: string;
  control: string;
}

interface FocusMark {
  /** What had focus. */
  element: Element;
  /** The card it was in, and which of the card's controls it was. */
  cardId?: string;
  control?: string;
  /** The toolbar it was in. */
  toolbar?: Element;
}

interface Listed {
  cardIds: readonly string[];
  home?: FocusHome;
}

const CARD = '[data-note-id]';
const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Keeps focus in `regionRef`, a list of note cards (data-note-id) shown in
 * the order of `cardIds`, when the element holding it leaves the page:
 * - moved (re-sorted): focus stays on it;
 * - in a card that left the list: the same control on the card that took its
 *   place (the next one, or the previous one at the end), or that card itself;
 * - in a toolbar that is still there: the toolbar's first control;
 * - anywhere else (a toolbar that went away): `home` as it was before;
 * - with no cards left: the region's first control (an empty state's button),
 *   or the region itself.
 * Cards and the region need tabIndex -1 to take focus. Focus the user moved
 * on (a click, Tab) is left alone.
 */
export function useFocusKeeper(regionRef: RefObject<HTMLElement | null>, cardIds: readonly string[], home?: FocusHome): void {
  const mark = useRef<FocusMark | null>(null);
  const listed = useRef<Listed>({ cardIds, home });

  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      mark.current = markOf(event.target, regionRef.current);
    };
    // A press anywhere else moves focus on, or to nothing: not ours to bring back.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !mark.current?.element.contains(target)) mark.current = null;
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [regionRef]);

  // After every render: did it just take the focused element away?
  useLayoutEffect(() => {
    const before = listed.current;
    listed.current = { cardIds, home };
    const region = regionRef.current;
    const lost = mark.current;
    if (!region || !lost || !focusIsLost()) return;
    const target = region.contains(lost.element) ? lost.element : placeOf(lost, before, cardIds, region);
    if (target instanceof HTMLElement) target.focus();
    // Focused (a new mark), or nowhere to go: either way, done with this one.
    if (mark.current === lost) mark.current = null;
  });
}

/** Browsers hand focus to the body when its element leaves the page; some engines keep pointing at the element. */
function focusIsLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active === document.documentElement || !active.isConnected;
}

function markOf(target: EventTarget | null, region: HTMLElement | null): FocusMark | null {
  if (!region || !(target instanceof Element) || !region.contains(target)) return null;
  return {
    element: target,
    cardId: target.closest(CARD)?.getAttribute('data-note-id') ?? undefined,
    control: target.closest(`[${CARD_CONTROL}]`)?.getAttribute(CARD_CONTROL) ?? undefined,
    toolbar: target.closest('[role="toolbar"]') ?? undefined,
  };
}

function placeOf(lost: FocusMark, before: Listed, now: readonly string[], region: HTMLElement): Element {
  if (lost.cardId === undefined && lost.toolbar?.isConnected) {
    const first = lost.toolbar.querySelector(FOCUSABLE);
    if (first) return first;
  }
  const from = lost.cardId === undefined ? before.home : { cardId: lost.cardId, control: lost.control };
  const card = from && cardById(region, successor(from.cardId, before.cardIds, now));
  if (from && card) return controlOf(card, from.control) ?? card;
  return region.querySelector(CARD) ?? region.querySelector(FOCUSABLE) ?? region;
}

/** The card in `id`'s place: itself if still listed, else the next card that still is, else the previous one. */
function successor(id: string, before: readonly string[], now: readonly string[]): string | undefined {
  if (now.includes(id)) return id;
  const at = before.indexOf(id);
  if (at < 0) return now[0];
  const listed = new Set(now);
  return before.slice(at + 1).find((c) => listed.has(c)) ?? before.slice(0, at).findLast((c) => listed.has(c));
}

function cardById(region: HTMLElement, id: string | undefined): Element | undefined {
  if (id === undefined) return undefined;
  return [...region.querySelectorAll(CARD)].find((card) => card.getAttribute('data-note-id') === id);
}

function controlOf(card: Element, control: string | undefined): Element | undefined {
  if (control === undefined) return undefined;
  return [...card.querySelectorAll(`[${CARD_CONTROL}]`)].find(
    (el) => el.getAttribute(CARD_CONTROL) === control && !el.matches(':disabled'),
  );
}
