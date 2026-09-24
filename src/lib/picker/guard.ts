import { isWebmarkNode } from '@/lib/constants';

export interface TrailingGuardOptions {
  types: readonly string[];
  durationMs: number;
  /** Only swallow events that match (default: all of `types`). */
  matches?: (e: Event) => boolean;
  /** Stop guarding right after swallowing an event of this type. */
  endOn?: string;
}

/**
 * The picker ends in the middle of a gesture (on the first click of a
 * double-click, on keydown of Enter). Swallow the rest of that gesture for a
 * moment so the page doesn't act on it, e.g. a link under the second click
 * navigating away. WebMark's own UI still receives everything. Returns a
 * function that ends the guard early.
 */
export function swallowTrailingInput(win: Window, options: TrailingGuardOptions): () => void {
  const controller = new AbortController();
  const swallow = (e: Event): void => {
    const target = e.target;
    if (target instanceof Node && isWebmarkNode(target)) return;
    if (options.matches && !options.matches(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === options.endOn) controller.abort();
  };
  for (const type of options.types) {
    win.addEventListener(type, swallow, { capture: true, signal: controller.signal });
  }
  const timer = setTimeout(() => controller.abort(), options.durationMs);
  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}
