import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { readViewport } from './dom';
import { intersectsViewport, type RectLike, type Size } from './geometry';

/*
 * Measures the page elements WebMark draws next to (pinned elements, the
 * editor's target, hover/flash outlines) and publishes their viewport boxes.
 *
 * All reads happen in one batched pass per animation frame, with no writes in
 * between, so we never force extra layouts on the page. Passes are triggered by
 * scroll/resize, ResizeObserver on the tracked elements, DOM changes (via
 * `schedule()`), and a slow interval that catches everything else (CSS
 * transitions, content shifting above an element) while anything is tracked.
 */

export interface Box extends RectLike {
  /** Still in the document. */
  connected: boolean;
  /** Has size, is rendered, and is at least partly inside the viewport. */
  visible: boolean;
}

export interface LayoutSnapshot {
  viewport: Size;
  boxes: ReadonlyMap<Element, Box>;
}

const FALLBACK_INTERVAL_MS = 1000;
const EPSILON = 0.25;

const DETACHED: Box = { top: 0, left: 0, width: 0, height: 0, connected: false, visible: false };

function measureElement(el: Element, viewport: Size): Box {
  if (!el.isConnected) return DETACHED;
  const r = el.getBoundingClientRect();
  const box = { top: r.top, left: r.left, width: r.width, height: r.height };
  let visible = r.width >= 1 && r.height >= 1 && intersectsViewport(box, viewport);
  // Catches visibility:hidden / content-visibility ancestors that still take up space.
  if (visible && typeof el.checkVisibility === 'function') {
    visible = el.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions);
  }
  return { ...box, connected: true, visible };
}

function sameBox(a: Box, b: Box): boolean {
  return (
    a.connected === b.connected &&
    a.visible === b.visible &&
    Math.abs(a.top - b.top) < EPSILON &&
    Math.abs(a.left - b.left) < EPSILON &&
    Math.abs(a.width - b.width) < EPSILON &&
    Math.abs(a.height - b.height) < EPSILON
  );
}

export class LayoutTracker {
  private targets = new Set<Element>();
  private snapshot: LayoutSnapshot = { viewport: readViewport(), boxes: new Map() };
  private readonly listeners = new Set<() => void>();
  private readonly resizeObserver: ResizeObserver;
  private frame = 0;
  private interval = 0;
  private disposed = false;

  constructor(private readonly ctx: ContentScriptContext) {
    this.resizeObserver = new ResizeObserver(() => this.schedule());
    const onViewportChange = () => this.schedule();
    ctx.addEventListener(window, 'scroll', onViewportChange, { capture: true, passive: true });
    ctx.addEventListener(window, 'resize', onViewportChange, { passive: true });
    ctx.onInvalidated(() => this.dispose());
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): LayoutSnapshot => this.snapshot;

  /** Replace the set of tracked elements. Measures synchronously when it changes. */
  setTargets(elements: Iterable<Element>): void {
    const next = new Set(elements);
    if (next.size === this.targets.size && [...next].every((el) => this.targets.has(el))) return;
    for (const el of this.targets) if (!next.has(el)) this.resizeObserver.unobserve(el);
    for (const el of next) if (!this.targets.has(el)) this.resizeObserver.observe(el);
    this.targets = next;
    this.updateInterval();
    this.measure();
  }

  /** Request a measurement pass on the next animation frame (coalesced). */
  readonly schedule = (): void => {
    if (this.frame || this.disposed || !this.targets.size) return;
    // Reading isInvalid also lets an orphaned script (extension reloaded) notice and tear down.
    if (this.ctx.isInvalid) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.measure();
    });
  };

  private measure(): void {
    if (this.disposed) return;
    const viewport = readViewport();
    const prev = this.snapshot;
    const boxes = new Map<Element, Box>();
    let changed =
      viewport.width !== prev.viewport.width ||
      viewport.height !== prev.viewport.height ||
      this.targets.size !== prev.boxes.size;
    for (const el of this.targets) {
      const old = prev.boxes.get(el);
      const box = measureElement(el, viewport);
      // Reuse unchanged boxes so selectors keep returning the same object.
      if (old && sameBox(old, box)) {
        boxes.set(el, old);
      } else {
        boxes.set(el, box);
        changed = true;
      }
    }
    if (!changed) return;
    this.snapshot = { viewport, boxes };
    this.listeners.forEach((listener) => listener());
  }

  private updateInterval(): void {
    if (this.targets.size && !this.interval) {
      this.interval = window.setInterval(this.schedule, FALLBACK_INTERVAL_MS);
    } else if (!this.targets.size && this.interval) {
      window.clearInterval(this.interval);
      this.interval = 0;
    }
  }

  private dispose(): void {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.interval) window.clearInterval(this.interval);
    this.resizeObserver.disconnect();
    this.targets.clear();
    this.listeners.clear();
  }
}
