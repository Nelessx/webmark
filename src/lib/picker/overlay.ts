import { promoteToTopLayer } from '../topLayer';
import { placeTooltip } from './geometry';
import { PICKER_CSS } from './styles';

export interface Overlay {
  /** Highlight `el`. `instant` skips the glide transition (scroll, first show). */
  show(el: Element, instant: boolean): void;
  hide(): void;
  /**
   * Place the hint bar for the pointer at (x, y), or `null` when it is outside
   * the window. Near the bottom edge the bar moves to the top, out of the way,
   * unless the pointer is heading for it (its Cancel button must stay
   * reachable): then it stays, faded until the pointer is on it.
   */
  placeHint(pointer: { x: number; y: number } | null): void;
  destroy(): void;
}

/** Pointer this close to the bottom edge moves the hint bar to the top, out of the way. */
const HINT_FLIP_ZONE = 96;
/** Horizontal slack around the hint bar in which the pointer counts as heading for it. */
const HINT_REACH = 24;

const HINT_KEYS: readonly [key: string, action: string][] = [
  ['↑', 'parent'],
  ['↓', 'child'],
  ['Enter', 'confirm'],
  ['Esc', 'cancel'],
];

/**
 * Highlight box, label tooltip and hint bar, rendered into `container`.
 * Everything is pointer-events: none so the page element underneath stays
 * hit-testable. DOM writes are skipped when nothing changed, and the tooltip
 * is only measured when its text changes.
 */
export function createOverlay(
  container: HTMLElement,
  describe: (el: Element) => string,
  onCancel: () => void,
): Overlay {
  const doc = container.ownerDocument;
  const root = createEl(doc, 'div', 'wm-picker');
  const style = doc.createElement('style');
  style.textContent = PICKER_CSS;
  const box = createEl(doc, 'div', 'wm-picker-box');
  const tip = createEl(doc, 'div', 'wm-picker-tip');
  const tipLabel = createEl(doc, 'span', 'wm-picker-tip-label');
  const tipSize = createEl(doc, 'span', 'wm-picker-tip-size');
  const hint = createHint(doc, onCancel);
  tip.append(tipLabel, tipSize);
  box.hidden = true;
  tip.hidden = true;
  root.append(style, box, tip, hint);
  container.append(root);
  promoteToTopLayer(root);

  let labelledEl: Element | null = null;
  let shownWidth = -1;
  let shownHeight = -1;
  let tipWidth = 0;
  let tipHeight = 0;
  let tipNeedsMeasure = true;
  let instantClass = false;
  let hintAtTop = false;
  let hintFaded = false;
  let visible = false;
  const boxState = { x: NaN, y: NaN, width: NaN, height: NaN };
  const tipState = { x: NaN, y: NaN };

  function show(el: Element, instant: boolean): void {
    // Reads first (one layout), then writes.
    const rect = el.getBoundingClientRect();
    // Non-zero only if a transformed ancestor displaced our fixed layer.
    const origin = root.getBoundingClientRect();
    const viewport = viewportSize(doc);

    setInstant(instant || !visible);
    setVisible(true);
    writeBox(rect.left - origin.left, rect.top - origin.top, rect.width, rect.height);
    updateTipText(el, Math.round(rect.width), Math.round(rect.height));
    if (tipNeedsMeasure) {
      tipWidth = tip.offsetWidth;
      tipHeight = tip.offsetHeight;
      tipNeedsMeasure = false;
    }
    const at = placeTooltip(rect, { width: tipWidth, height: tipHeight }, viewport);
    writeTip(at.x - origin.left, at.y - origin.top);
  }

  function updateTipText(el: Element, width: number, height: number): void {
    if (el !== labelledEl) {
      tipLabel.textContent = describe(el);
      labelledEl = el;
      tipNeedsMeasure = true;
    }
    if (width !== shownWidth || height !== shownHeight) {
      tipSize.textContent = `${width} × ${height}`;
      shownWidth = width;
      shownHeight = height;
      tipNeedsMeasure = true;
    }
  }

  function writeBox(x: number, y: number, width: number, height: number): void {
    if (x !== boxState.x || y !== boxState.y) {
      box.style.transform = `translate(${x}px, ${y}px)`;
      boxState.x = x;
      boxState.y = y;
    }
    if (width !== boxState.width) {
      box.style.width = `${width}px`;
      boxState.width = width;
    }
    if (height !== boxState.height) {
      box.style.height = `${height}px`;
      boxState.height = height;
    }
  }

  function writeTip(x: number, y: number): void {
    if (x === tipState.x && y === tipState.y) return;
    tip.style.transform = `translate(${x}px, ${y}px)`;
    tipState.x = x;
    tipState.y = y;
  }

  function setVisible(next: boolean): void {
    if (next === visible) return;
    box.hidden = !next;
    tip.hidden = !next;
    visible = next;
  }

  function setInstant(instant: boolean): void {
    if (instant === instantClass) return;
    root.classList.toggle('wm-picker--instant', instant);
    instantClass = instant;
  }

  return {
    show,
    hide() {
      setVisible(false);
    },
    placeHint(pointer) {
      const win = doc.defaultView;
      const nearBottom = !!pointer && !!win && pointer.y > win.innerHeight - HINT_FLIP_ZONE;
      let atTop = false;
      let faded = false;
      if (pointer && nearBottom) {
        const r = hint.getBoundingClientRect();
        const headingForHint = pointer.x >= r.left - HINT_REACH && pointer.x <= r.right + HINT_REACH;
        const onHint = headingForHint && pointer.y >= r.top && pointer.y <= r.bottom;
        atTop = !headingForHint;
        faded = headingForHint && !onHint;
      }
      if (atTop !== hintAtTop) {
        hint.classList.toggle('wm-picker-hint--top', atTop);
        hintAtTop = atTop;
      }
      if (faded !== hintFaded) {
        hint.classList.toggle('wm-picker-hint--faded', faded);
        hintFaded = faded;
      }
    },
    destroy() {
      root.remove();
    },
  };
}

function createEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  return el;
}

/** "Click to select · ↑ parent · ↓ child · Enter confirm · Esc cancel", with key caps and a Cancel button. */
function createHint(doc: Document, onCancel: () => void): HTMLElement {
  const hint = createEl(doc, 'div', 'wm-picker-hint');
  hint.setAttribute('role', 'status');
  // The key hints give way (clipped) on narrow windows; the Cancel button doesn't.
  const keys = createEl(doc, 'span', 'wm-picker-hint-keys');
  const lead = createEl(doc, 'span');
  lead.textContent = 'Click to select';
  keys.append(lead);
  hint.append(createEl(doc, 'span', 'wm-picker-hint-dot'), keys);
  for (const [key, action] of HINT_KEYS) {
    const sep = createEl(doc, 'span', 'wm-picker-hint-sep');
    sep.textContent = ' · ';
    const item = createEl(doc, 'span');
    const kbd = createEl(doc, 'kbd');
    kbd.textContent = key;
    item.append(kbd, ` ${action}`);
    keys.append(sep, item);
  }
  // For mouse users, and when the keyboard is elsewhere (picking started from the side panel).
  const cancel = createEl(doc, 'button', 'wm-picker-cancel');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.setAttribute('data-wm-picker-cancel', '');
  // Don't move focus: the page element that had it keeps it.
  cancel.addEventListener('mousedown', (event) => event.preventDefault());
  cancel.addEventListener('click', onCancel);
  hint.append(cancel);
  return hint;
}

function viewportSize(doc: Document): { width: number; height: number } {
  const win = doc.defaultView;
  const innerWidth = win?.innerWidth ?? 0;
  // clientWidth excludes the vertical scrollbar, so the tooltip never hides under it.
  const clientWidth = doc.documentElement.clientWidth;
  return {
    width: clientWidth > 0 ? Math.min(innerWidth, clientWidth) : innerWidth,
    height: win?.innerHeight ?? 0,
  };
}
