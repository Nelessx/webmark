import { placeTooltip } from './geometry';
import { PICKER_CSS } from './styles';

export interface Overlay {
  /** Highlight `el`. `instant` skips the glide transition (scroll, first show). */
  show(el: Element, instant: boolean): void;
  hide(): void;
  /** Move the hint bar to the top edge (when the pointer is down by the bottom one). */
  setHintAtTop(atTop: boolean): void;
  destroy(): void;
}

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
export function createOverlay(container: HTMLElement, describe: (el: Element) => string): Overlay {
  const doc = container.ownerDocument;
  const root = createEl(doc, 'div', 'wm-picker');
  const style = doc.createElement('style');
  style.textContent = PICKER_CSS;
  const box = createEl(doc, 'div', 'wm-picker-box');
  const tip = createEl(doc, 'div', 'wm-picker-tip');
  const tipLabel = createEl(doc, 'span', 'wm-picker-tip-label');
  const tipSize = createEl(doc, 'span', 'wm-picker-tip-size');
  const hint = createHint(doc);
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
    setHintAtTop(atTop) {
      if (atTop === hintAtTop) return;
      hint.classList.toggle('wm-picker-hint--top', atTop);
      hintAtTop = atTop;
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

/** "Click to select · ↑ parent · ↓ child · Enter confirm · Esc cancel", with key caps. */
function createHint(doc: Document): HTMLElement {
  const hint = createEl(doc, 'div', 'wm-picker-hint');
  hint.setAttribute('role', 'status');
  const lead = createEl(doc, 'span');
  lead.textContent = 'Click to select';
  hint.append(createEl(doc, 'span', 'wm-picker-hint-dot'), lead);
  for (const [key, action] of HINT_KEYS) {
    const sep = createEl(doc, 'span', 'wm-picker-hint-sep');
    sep.textContent = ' · ';
    const item = createEl(doc, 'span');
    const kbd = createEl(doc, 'kbd');
    kbd.textContent = key;
    item.append(kbd, ` ${action}`);
    hint.append(sep, item);
  }
  return hint;
}

/**
 * Put the overlay in the browser's top layer when supported, so it renders
 * above any z-index the page uses (and above page popovers and dialogs opened
 * earlier), with the viewport as its containing block.
 */
function promoteToTopLayer(root: HTMLElement): void {
  if (typeof root.showPopover !== 'function') return;
  try {
    root.setAttribute('popover', 'manual');
    root.showPopover();
  } catch {
    root.removeAttribute('popover');
  }
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
