import { WEBMARK_HOST_TAG, isWebmarkNode } from '@/lib/constants';
import type { PickerHandle, PickerOptions } from './index';
import { safeDescribe } from './describe';
import { swallowTrailingInput, type TrailingGuardOptions } from './guard';
import { createDefaultHitTest, type HitTest } from './hit-test';
import { firstVisibleChild, parentFor } from './navigation';
import { createOverlay } from './overlay';
import { injectPageStyle } from './page-style';

/** Environment seams, overridable in tests (jsdom has no elementsFromPoint and no trusted events). */
export interface PickerDeps {
  hitTest: HitTest;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  /** Only real user input may move, pick or cancel; page scripts' synthetic events are just blocked. */
  isTrusted: (e: Event) => boolean;
}

/** Hidden from the page and default action cancelled, so nothing on the page reacts. */
const BLOCKED_EVENTS = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'submit',
  'dragstart',
  'selectstart',
] as const;

/**
 * Hidden from the page but NOT cancelled: cancelling touchstart/touchend would
 * disable touch scrolling and suppress the click a tap produces, which is how
 * touch input picks. The mouse events and click that follow are blocked above.
 */
const ISOLATED_TOUCH_EVENTS = ['touchstart', 'touchend'] as const;

const KEY_EVENTS = ['keydown', 'keypress', 'keyup'] as const;
const HANDLED_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'Enter', 'Escape']);

/** The rest of a click gesture that may still arrive after we stop (second click of a double-click). */
const TRAILING_POINTER: TrailingGuardOptions = {
  types: ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'],
  durationMs: 500,
};
const TRAILING_KEY_MS = 1000;

/** Pointer this close to the bottom edge moves the hint bar to the top, out of the way. */
const HINT_FLIP_ZONE = 96;

/** WebMark's own controls (e.g. a toolbar Cancel button) keep working while picking. */
const WEBMARK_CONTROL_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="switch"]',
].join(',');

let activePicker: PickerHandle | null = null;
/** Ends the trailing-input guard left by the last pick/cancel, so it can't eat a new picker's input. */
let endTrailingGuard: (() => void) | null = null;

/**
 * Start picking. Only one picker runs at a time: starting a new one silently
 * stops the previous one (no callbacks). See startPicker() for the contract.
 */
export function createPicker(options: PickerOptions, deps: Partial<PickerDeps> = {}): PickerHandle {
  activePicker?.stop();
  endTrailingGuard?.();
  endTrailingGuard = null;

  const { container, onPick, onCancel } = options;
  const doc = container.ownerDocument;
  const maybeWin = doc.defaultView;
  if (!maybeWin || !container.isConnected) {
    console.warn('[WebMark] picker not started: its container is not attached to the page.');
    return { stop() {}, active: false };
  }
  const win: Window = maybeWin;

  const hitTest = deps.hitTest ?? createDefaultHitTest(doc);
  const requestFrame = deps.requestFrame ?? ((callback) => win.requestAnimationFrame(callback));
  const cancelFrame = deps.cancelFrame ?? ((id) => win.cancelAnimationFrame(id));
  const isTrusted = deps.isTrusted ?? ((e) => e.isTrusted);

  const listeners = new AbortController();
  const overlay = createOverlay(container, safeDescribe);
  const removePageStyle = injectPageStyle(doc);

  let active = true;
  /** Raw hit-test result under the pointer. */
  let hovered: Element | null = null;
  /** Highlighted element: `hovered`, or an ancestor/descendant reached with the arrow keys. */
  let current: Element | null = null;
  /** Elements climbed from with ArrowUp, so ArrowDown can retrace the path. */
  const climbed: Element[] = [];
  let pointerX = 0;
  let pointerY = 0;
  let pointerInside = false;
  /** A trusted pointerdown happened while picking: only then does a click pick. */
  let pressed = false;
  let frameId = 0;
  let framePending = false;
  let pointerMoved = false;
  let layoutChanged = false;

  const handle: PickerHandle = {
    stop,
    get active() {
      return active;
    },
  };
  activePicker = handle;

  listen(BLOCKED_EVENTS, onBlockedEvent, false);
  listen(ISOLATED_TOUCH_EVENTS, onTouchEvent, true);
  listen(KEY_EVENTS, onKeyEvent, false);
  listen(['pointermove'], onPointerMove, true);
  listen(['pointerout'], onPointerOut, true);
  // Capture catches scrolling in inner containers too (scroll doesn't bubble).
  listen(['scroll', 'resize'], onLayoutChange, true);

  return handle;

  function listen(types: readonly string[], handler: (e: Event) => void, passive: boolean): void {
    const wrapped = guarded(handler);
    const opts: AddEventListenerOptions = { capture: true, passive, signal: listeners.signal };
    for (const type of types) win.addEventListener(type, wrapped, opts);
  }

  /** Every entry point: bail out once stopped, step aside if our UI is gone, never throw into the page. */
  function guarded(fn: (e: Event) => void): (e: Event) => void {
    return (e) => {
      if (!active) return;
      // WebMark's UI was removed (e.g. the extension reloaded): stop and let the page have its events.
      if (!container.isConnected) {
        stop();
        return;
      }
      try {
        fn(e);
      } catch (err) {
        reportError(err);
      }
    };
  }

  function onBlockedEvent(e: Event): void {
    if (isWebmarkControlEvent(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!isTrusted(e)) return;
    if (e.type === 'pointerdown') onPress(e as PointerEvent);
    else if (e.type === 'click') onClick(e as MouseEvent);
  }

  function onTouchEvent(e: Event): void {
    if (isWebmarkControlEvent(e)) return;
    e.stopImmediatePropagation();
  }

  function onKeyEvent(e: Event): void {
    const key = e as KeyboardEvent;
    if (!HANDLED_KEYS.has(key.key) || key.ctrlKey || key.altKey || key.metaKey || key.isComposing) return;
    key.preventDefault();
    key.stopImmediatePropagation();
    if (key.type !== 'keydown' || !isTrusted(key)) return;

    switch (key.key) {
      case 'ArrowUp':
        selectParent();
        break;
      case 'ArrowDown':
        selectChild();
        break;
      case 'Enter':
        if (current) confirm(current, trailingKey('Enter'));
        break;
      case 'Escape':
        cancel(trailingKey('Escape'));
        break;
    }
  }

  function onPress(e: PointerEvent): void {
    pressed = true;
    pointAt(e.clientX, e.clientY);
    hoverAt(pointerX, pointerY);
    render(false);
  }

  function onClick(e: MouseEvent): void {
    // A click without a pointerdown came from the keyboard (Space/Enter on a focused control).
    if (!pressed) return;
    pointAt(e.clientX, e.clientY);
    hoverAt(pointerX, pointerY);
    if (current) confirm(current, TRAILING_POINTER);
  }

  function onPointerMove(e: Event): void {
    const pointer = e as PointerEvent;
    pointAt(pointer.clientX, pointer.clientY);
    pointerMoved = true;
    scheduleFrame();
  }

  function onPointerOut(e: Event): void {
    const pointer = e as PointerEvent;
    if (pointer.relatedTarget !== null) return;
    const { clientX: x, clientY: y } = pointer;
    if (x >= 0 && y >= 0 && x < win.innerWidth && y < win.innerHeight) return;
    // The pointer left the window: nothing is highlighted until it comes back.
    pointerInside = false;
    clearSelection();
    overlay.hide();
  }

  function onLayoutChange(): void {
    layoutChanged = true;
    scheduleFrame();
  }

  function scheduleFrame(): void {
    if (framePending) return;
    framePending = true;
    frameId = requestFrame(runFrame);
  }

  function runFrame(): void {
    framePending = false;
    if (!active) return;
    if (!container.isConnected) {
      stop();
      return;
    }
    try {
      updateFrame();
    } catch (err) {
      reportError(err);
    }
  }

  function updateFrame(): void {
    // Content scrolling under a still pointer counts as moving onto a new element,
    // unless the user navigated with the keys (then keep their choice, just reposition).
    const instant = layoutChanged && !pointerMoved;
    if (current && !current.isConnected) clearSelection();
    if (pointerInside && (pointerMoved || current === hovered)) hoverAt(pointerX, pointerY);
    pointerMoved = false;
    layoutChanged = false;
    overlay.setHintAtTop(pointerInside && pointerY > win.innerHeight - HINT_FLIP_ZONE);
    render(instant);
  }

  function pointAt(x: number, y: number): void {
    pointerX = x;
    pointerY = y;
    pointerInside = true;
  }

  function hoverAt(x: number, y: number): void {
    const hit = hitTest(x, y);
    if (hit === hovered) return;
    hovered = hit;
    current = hit;
    climbed.length = 0;
  }

  function clearSelection(): void {
    hovered = null;
    current = null;
    climbed.length = 0;
  }

  function render(instant: boolean): void {
    if (current) overlay.show(current, instant);
    else overlay.hide();
  }

  function selectParent(): void {
    if (!current) return;
    const parent = parentFor(current);
    if (!parent) return;
    climbed.push(current);
    current = parent;
    render(false);
  }

  function selectChild(): void {
    if (!current) return;
    const child = popClimbedChild(current) ?? firstVisibleChild(current);
    if (!child) return;
    current = child;
    render(false);
  }

  function popClimbedChild(from: Element): Element | null {
    // Skip entries the page removed or moved since we climbed past them.
    for (let el = climbed.pop(); el; el = climbed.pop()) {
      if (el !== from && el.isConnected && from.contains(el)) return el;
    }
    return null;
  }

  function confirm(el: Element, trailing: TrailingGuardOptions): void {
    finish(trailing);
    runCallback(() => onPick(el));
  }

  function cancel(trailing: TrailingGuardOptions): void {
    finish(trailing);
    runCallback(onCancel);
  }

  function finish(trailing: TrailingGuardOptions): void {
    stop();
    runCallback(() => {
      endTrailingGuard = swallowTrailingInput(win, trailing);
    });
  }

  function stop(): void {
    if (!active) return;
    active = false;
    listeners.abort();
    if (framePending) runCallback(() => cancelFrame(frameId));
    framePending = false;
    runCallback(() => overlay.destroy());
    runCallback(removePageStyle);
    if (activePicker === handle) activePicker = null;
  }
}

function trailingKey(key: string): TrailingGuardOptions {
  return {
    types: KEY_EVENTS,
    durationMs: TRAILING_KEY_MS,
    matches: (e) => (e as KeyboardEvent).key === key,
    endOn: 'keyup',
  };
}

/** Pointer input aimed at one of WebMark's own controls (not decoration) passes through untouched. */
function isWebmarkControlEvent(e: Event): boolean {
  const target = e.target;
  if (!(target instanceof Node) || !isWebmarkNode(target)) return false;
  for (const node of e.composedPath()) {
    if (!(node instanceof Element)) continue;
    if (node.localName === WEBMARK_HOST_TAG) return false;
    if (node.matches(WEBMARK_CONTROL_SELECTOR)) return true;
  }
  return false;
}

function runCallback(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    reportError(err);
  }
}

function reportError(err: unknown): void {
  console.error('[WebMark] picker error:', err);
}
