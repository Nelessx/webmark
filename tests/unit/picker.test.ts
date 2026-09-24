import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEBMARK_HOST_TAG } from '@/lib/constants';
import { createPicker, startPicker, type PickerDeps, type PickerHandle } from '@/lib/picker';
import { placeTooltip } from '@/lib/picker/geometry';
import { createDefaultHitTest } from '@/lib/picker/hit-test';

// Deterministic tooltip labels (the real describeElement is owned by the anchor module).
vi.mock('@/lib/anchor', () => ({
  describeElement: (el: Element) => el.id || el.localName,
}));

const HINT_TEXT = 'Click to select · ↑ parent · ↓ child · Enter confirm · Esc cancel';

let host: HTMLElement;
let shadow: ShadowRoot;
let container: HTMLElement;
let outer: HTMLElement;
let middle: HTMLElement;
let inner: HTMLElement;
let other: HTMLElement;
/** What the fake hit test reports under the pointer. */
let under: Element | null;
const handles: PickerHandle[] = [];

const testDeps: Partial<PickerDeps> = {
  hitTest: () => under,
  requestFrame: (callback) => {
    callback();
    return 1;
  },
  cancelFrame: () => {},
  isTrusted: () => true,
};

beforeEach(() => {
  document.body.innerHTML = `
    <main id="outer">
      <section id="middle"><button id="inner">Buy</button></section>
    </main>
    <a id="other" href="#other">Other</a>`;
  outer = byId('outer');
  middle = byId('middle');
  inner = byId('inner');
  other = byId('other');
  host = document.createElement(WEBMARK_HOST_TAG);
  document.body.append(host);
  shadow = host.attachShadow({ mode: 'open' });
  container = document.createElement('div');
  shadow.append(container);
  under = null;
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop();
  document.body.replaceChildren();
  document.head.replaceChildren();
  vi.useRealTimers();
});

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function start(deps: Partial<PickerDeps> = testDeps) {
  const onPick = vi.fn<(el: Element) => void>();
  const onCancel = vi.fn<() => void>();
  const handle = createPicker({ container, onPick, onCancel }, deps);
  handles.push(handle);
  return { handle, onPick, onCancel };
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) };
}

function stubRect(el: Element, value: DOMRect): void {
  el.getBoundingClientRect = () => value;
}

function hover(el: Element | null, clientY = 10): void {
  under = el;
  (el ?? document.body).dispatchEvent(
    new PointerEvent('pointermove', { bubbles: true, composed: true, clientX: 10, clientY }),
  );
}

function press(key: string, init: KeyboardEventInit = {}, type = 'keydown'): KeyboardEvent {
  const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, composed: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

function mouse(target: EventTarget, type: string): MouseEvent {
  const init = { bubbles: true, cancelable: true, composed: true, clientX: 10, clientY: 10, detail: 1 };
  const event = type.startsWith('pointer') ? new PointerEvent(type, init) : new MouseEvent(type, init);
  target.dispatchEvent(event);
  return event;
}

/** A full primary click as the browser dispatches it. Returns the click event. */
function clickSequence(target: Element): MouseEvent {
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) mouse(target, type);
  return mouse(target, 'click');
}

function overlayPart(className: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`.${className}`);
  if (!el) throw new Error(`missing .${className}`);
  return el;
}

const label = () => overlayPart('wm-picker-tip-label').textContent;
const cursorStyle = () => document.getElementById('webmark-picker-cursor');

/** Records page listeners (capture on document + bubble on the element) for the given events. */
function spyOnPage(target: Element, types: string[]) {
  const seen: string[] = [];
  for (const type of types) {
    document.addEventListener(type, () => seen.push(`document:${type}`), true);
    target.addEventListener(type, () => seen.push(`target:${type}`));
  }
  return seen;
}

describe('picker lifecycle', () => {
  it('renders the overlay, hint bar and crosshair style while active', () => {
    const { handle } = start();

    expect(handle.active).toBe(true);
    const root = overlayPart('wm-picker');
    expect(root.querySelector('style')?.textContent).toContain('.wm-picker-box');
    expect(overlayPart('wm-picker-hint').textContent).toBe(HINT_TEXT);
    expect(overlayPart('wm-picker-box').hidden).toBe(true);
    const style = cursorStyle();
    expect(style?.parentNode).toBe(document.head);
    expect(style?.textContent).toContain('cursor: crosshair !important;');
  });

  it('removes its DOM, cursor style and listeners on stop', () => {
    const { handle, onPick, onCancel } = start();
    handle.stop();

    expect(handle.active).toBe(false);
    expect(container.childElementCount).toBe(0);
    expect(cursorStyle()).toBeNull();

    const seen = spyOnPage(inner, ['click', 'keydown']);
    const click = clickSequence(inner);
    const esc = press('Escape');
    hover(inner);
    expect(click.defaultPrevented).toBe(false);
    expect(esc.defaultPrevented).toBe(false);
    expect(seen).toEqual(['document:click', 'target:click', 'document:keydown']);
    expect(onPick).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(container.childElementCount).toBe(0);
  });

  it('stop is idempotent and a stale stop does not touch a newer picker', () => {
    const first = start();
    first.handle.stop();
    expect(() => first.handle.stop()).not.toThrow();

    const second = start();
    first.handle.stop();
    expect(second.handle.active).toBe(true);
    expect(cursorStyle()).not.toBeNull();
    expect(first.onPick).not.toHaveBeenCalled();
    expect(first.onCancel).not.toHaveBeenCalled();
  });

  it('starting a picker stops the previous one', () => {
    const first = start();
    const second = start();

    expect(first.handle.active).toBe(false);
    expect(second.handle.active).toBe(true);
    expect(container.querySelectorAll('.wm-picker')).toHaveLength(1);
    expect(document.querySelectorAll('#webmark-picker-cursor')).toHaveLength(1);
  });

  it('startPicker uses the real environment and cleans up', () => {
    const handle = startPicker({ container, onPick: () => {}, onCancel: () => {} });
    handles.push(handle);
    expect(handle.active).toBe(true);
    handle.stop();
    expect(container.childElementCount).toBe(0);
    expect(cursorStyle()).toBeNull();
  });

  it('stops quietly once its container is detached (extension reload)', () => {
    const { handle, onPick, onCancel } = start();
    host.remove();

    const seen = spyOnPage(inner, ['click']);
    const click = clickSequence(inner);

    expect(handle.active).toBe(false);
    expect(click.defaultPrevented).toBe(false);
    expect(seen).toEqual(['document:click', 'target:click']);
    expect(cursorStyle()).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('does not start with a detached container', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    container.remove();
    const { handle } = start();

    expect(handle.active).toBe(false);
    expect(cursorStyle()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe('hover highlight', () => {
  it('outlines the element under the pointer with its label and size', () => {
    stubRect(inner, rect(10, 250, 320, 180));
    start();
    hover(inner);

    const box = overlayPart('wm-picker-box');
    expect(box.hidden).toBe(false);
    expect(box.style.transform).toBe('translate(10px, 250px)');
    expect(box.style.width).toBe('320px');
    expect(box.style.height).toBe('180px');
    expect(label()).toBe('inner');
    expect(overlayPart('wm-picker-tip-size').textContent).toBe('320 × 180');
    expect(overlayPart('wm-picker-tip').hidden).toBe(false);
  });

  it('hides when nothing pickable is under the pointer', () => {
    start();
    hover(inner);
    hover(null);
    expect(overlayPart('wm-picker-box').hidden).toBe(true);
  });

  it('clears the highlight when the pointer leaves the window', () => {
    const { onPick } = start();
    hover(inner);
    document.body.dispatchEvent(
      new PointerEvent('pointerout', { bubbles: true, relatedTarget: null, clientX: -1, clientY: 10 }),
    );

    expect(overlayPart('wm-picker-box').hidden).toBe(true);
    expect(press('Enter').defaultPrevented).toBe(true);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('follows the highlighted element on scroll', () => {
    stubRect(inner, rect(10, 250, 320, 180));
    start();
    hover(inner);
    stubRect(inner, rect(10, 100, 320, 180));
    window.dispatchEvent(new Event('scroll'));

    expect(overlayPart('wm-picker-box').style.transform).toBe('translate(10px, 100px)');
  });

  it('re-hit-tests on scroll, unless the user navigated with the keys', () => {
    start();
    hover(inner);
    under = other;
    window.dispatchEvent(new Event('scroll'));
    expect(label()).toBe('other');

    hover(inner);
    press('ArrowUp');
    under = other;
    window.dispatchEvent(new Event('scroll'));
    expect(label()).toBe('middle');
  });

  it('moves the hint bar to the top when the pointer nears the bottom edge', () => {
    start();
    const hint = overlayPart('wm-picker-hint');
    hover(inner, window.innerHeight - 10);
    expect(hint.classList.contains('wm-picker-hint--top')).toBe(true);
    hover(inner, 10);
    expect(hint.classList.contains('wm-picker-hint--top')).toBe(false);
  });
});

describe('keyboard navigation', () => {
  it('ArrowUp selects the parent and ArrowDown retraces the climbed path', () => {
    start();
    hover(inner);

    press('ArrowUp');
    expect(label()).toBe('middle');
    press('ArrowUp');
    expect(label()).toBe('outer');
    press('ArrowDown');
    expect(label()).toBe('middle');
    press('ArrowDown');
    expect(label()).toBe('inner');
  });

  it('ArrowUp stops below <body>', () => {
    start();
    hover(inner);
    for (let i = 0; i < 5; i++) press('ArrowUp');
    expect(label()).toBe('outer');
  });

  it('keeps the keyboard selection while the pointer stays on the same element', () => {
    start();
    hover(inner);
    press('ArrowUp');
    hover(inner);
    expect(label()).toBe('middle');
  });

  it('resets the climbed path when the pointer moves onto a different element', () => {
    const { onPick } = start();
    hover(inner);
    press('ArrowUp');
    hover(other);
    press('ArrowDown');
    expect(label()).toBe('other');

    press('Enter');
    expect(onPick).toHaveBeenCalledWith(other);
  });

  it('ArrowDown with no climbed path goes to the first visible child', () => {
    stubRect(inner, rect(0, 0, 40, 20));
    start();
    hover(middle);
    press('ArrowDown');
    expect(label()).toBe('inner');
  });

  it('Enter confirms the highlighted element', () => {
    const { handle, onPick, onCancel } = start();
    hover(inner);
    press('ArrowUp');
    const enter = press('Enter');

    expect(enter.defaultPrevented).toBe(true);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(middle);
    expect(onCancel).not.toHaveBeenCalled();
    expect(handle.active).toBe(false);
    expect(cursorStyle()).toBeNull();
  });

  it('hides handled keys from the page but lets other keys through', () => {
    start();
    hover(inner);
    const seen = spyOnPage(document.body, ['keydown', 'keyup']);

    expect(press('ArrowUp').defaultPrevented).toBe(true);
    press('ArrowUp', {}, 'keyup');
    expect(seen).toEqual([]);

    expect(press('a').defaultPrevented).toBe(false);
    expect(press('ArrowUp', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(seen).toEqual(['document:keydown', 'target:keydown', 'document:keydown', 'target:keydown']);
  });
});

describe('cancel', () => {
  it('Esc cancels, stops the picker and hides the key from the page', () => {
    vi.useFakeTimers();
    const { handle, onPick, onCancel } = start();
    hover(inner);
    const seen = spyOnPage(document.body, ['keydown', 'keyup']);
    const esc = press('Escape');

    expect(esc.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
    expect(handle.active).toBe(false);
    expect(container.childElementCount).toBe(0);
    expect(cursorStyle()).toBeNull();

    // The Esc keyup that follows is swallowed too, then the page gets keys again.
    press('Escape', {}, 'keyup');
    expect(seen).toEqual([]);
    press('Escape', {}, 'keyup');
    expect(seen).toEqual(['document:keyup', 'target:keyup']);
  });
});

describe('click to pick', () => {
  it('confirms once, and the page sees none of the click', () => {
    const { handle, onPick } = start();
    const seen = spyOnPage(inner, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    hover(inner);
    const click = clickSequence(inner);

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(inner);
    expect(click.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);
    expect(handle.active).toBe(false);
    expect(cursorStyle()).toBeNull();
  });

  it('picks the keyboard-selected ancestor when clicking without moving', () => {
    const { onPick } = start();
    hover(inner);
    press('ArrowUp');
    clickSequence(inner);
    expect(onPick).toHaveBeenCalledWith(middle);
  });

  it('swallows the rest of a double-click, then releases the page', () => {
    vi.useFakeTimers();
    const { onPick } = start();
    hover(inner);
    clickSequence(inner);
    const seen = spyOnPage(inner, ['mousedown', 'click', 'dblclick']);

    const second = clickSequence(inner);
    mouse(inner, 'dblclick');
    expect(second.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);

    vi.advanceTimersByTime(600);
    clickSequence(inner);
    expect(seen).toEqual(['document:mousedown', 'target:mousedown', 'document:click', 'target:click']);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('blocks but does not pick on a click without a press (keyboard activation)', () => {
    const { onPick } = start();
    hover(inner);
    const click = mouse(inner, 'click');
    expect(click.defaultPrevented).toBe(true);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('blocks but never acts on untrusted (script-dispatched) input', () => {
    const { handle, onPick, onCancel } = start({ ...testDeps, isTrusted: (e) => e.isTrusted });
    hover(inner);
    const click = clickSequence(inner);
    const esc = press('Escape');

    expect(click.defaultPrevented).toBe(true);
    expect(esc.defaultPrevented).toBe(true);
    expect(onPick).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(handle.active).toBe(true);
  });

  it('blocks form submission, context menus and drags', () => {
    start();
    const form = document.createElement('form');
    document.body.append(form);
    const seen = spyOnPage(form, ['submit', 'contextmenu', 'dragstart']);

    const submit = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submit);
    const menu = mouse(form, 'contextmenu');
    const drag = new Event('dragstart', { bubbles: true, cancelable: true });
    form.dispatchEvent(drag);

    expect([submit.defaultPrevented, menu.defaultPrevented, drag.defaultPrevented]).toEqual([true, true, true]);
    expect(seen).toEqual([]);
  });

  it("lets clicks on WebMark's own controls through", () => {
    const { handle, onPick } = start();
    const cancelButton = document.createElement('button');
    shadow.append(cancelButton);
    const clicked = vi.fn();
    cancelButton.addEventListener('click', clicked);
    hover(inner);

    const click = clickSequence(cancelButton);

    expect(click.defaultPrevented).toBe(false);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
    expect(handle.active).toBe(true);
  });

  it('clicks on non-interactive WebMark decoration pick the page element below', () => {
    const { onPick } = start();
    const decoration = document.createElement('div');
    shadow.append(decoration);
    under = inner;

    const click = clickSequence(decoration);
    expect(click.defaultPrevented).toBe(true);
    expect(onPick).toHaveBeenCalledWith(inner);
  });
});

describe('default hit test', () => {
  const restore: (() => void)[] = [];

  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
  });

  function stubPoint(top: Element | null, stack: Element[]): void {
    document.elementFromPoint = () => top;
    document.elementsFromPoint = () => stack;
    restore.push(() => {
      Reflect.deleteProperty(document, 'elementFromPoint');
      Reflect.deleteProperty(document, 'elementsFromPoint');
    });
  }

  it('skips WebMark UI and <html>, and falls back to <body> only when nothing else is there', () => {
    const hitTest = createDefaultHitTest(document);
    const html = document.documentElement;

    stubPoint(host, [host, container, inner, middle, outer, document.body, html]);
    expect(hitTest(5, 5)).toBe(inner);

    stubPoint(inner, [inner, middle]);
    expect(hitTest(5, 5)).toBe(inner);

    stubPoint(document.body, [document.body, html]);
    expect(hitTest(5, 5)).toBe(document.body);

    stubPoint(host, [host, document.body, html]);
    expect(hitTest(5, 5)).toBe(document.body);

    stubPoint(html, [html]);
    expect(hitTest(5, 5)).toBeNull();

    stubPoint(null, []);
    expect(hitTest(5, 5)).toBeNull();
  });

  it('returns the host for elements inside page shadow roots', () => {
    const widget = document.createElement('x-widget');
    document.body.append(widget);
    const part = document.createElement('span');
    widget.attachShadow({ mode: 'open' }).append(part);

    stubPoint(part, [part, widget, document.body]);
    expect(createDefaultHitTest(document)(5, 5)).toBe(widget);
  });

  it('finds a pointer-transparent iframe inside the element that was hit', () => {
    const frame = document.createElement('iframe');
    outer.append(frame);
    stubRect(frame, rect(100, 100, 300, 200));
    const hitTest = createDefaultHitTest(document);

    stubPoint(outer, [outer, document.body]);
    expect(hitTest(150, 150)).toBe(frame);
    expect(hitTest(50, 50)).toBe(outer);
  });

  it('is what the picker uses by default: WebMark UI is looked through', () => {
    const { onPick } = start({ ...testDeps, hitTest: undefined });
    stubPoint(host, [host, inner, middle, outer, document.body, document.documentElement]);
    hover(inner);
    clickSequence(host);
    expect(onPick).toHaveBeenCalledWith(inner);
  });
});

describe('placeTooltip', () => {
  const viewport = { width: 1000, height: 800 };
  const tip = { width: 200, height: 24 };

  it('prefers just above the element', () => {
    expect(placeTooltip(rect(100, 300, 50, 50), tip, viewport)).toEqual({ x: 100, y: 270 });
  });

  it('goes below when there is no room above', () => {
    expect(placeTooltip(rect(100, 10, 50, 50), tip, viewport)).toEqual({ x: 100, y: 66 });
  });

  it('sits inside the top edge of elements taller than the viewport', () => {
    expect(placeTooltip(rect(0, -50, 1000, 2000), tip, viewport)).toEqual({ x: 4, y: 6 });
  });

  it('stays inside the viewport horizontally', () => {
    expect(placeTooltip(rect(950, 300, 40, 40), tip, viewport).x).toBe(796);
    expect(placeTooltip(rect(-80, 300, 40, 40), tip, viewport).x).toBe(4);
  });
});
