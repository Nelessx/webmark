import { sendToBackground } from '@/lib/messages';
import { nextFrame, readViewport } from './dom';
import { clampRectToViewport, isFullyInViewport } from './geometry';

/** Attribute on the shadow host that hides all WebMark UI (see :host([data-wm-hidden]) in style.css). */
export const HIDDEN_ATTR = 'data-wm-hidden';

const CAPTURE_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/**
 * Screenshot the visible part of `el` via the background (captureVisibleTab +
 * crop). WebMark's own UI is hidden for two frames so it isn't in the shot.
 * Resolves undefined if the element isn't visible or capture fails.
 */
export async function captureElement(el: Element, host: HTMLElement): Promise<string | undefined> {
  if (!el.isConnected) return undefined;
  if (!isFullyInViewport(el.getBoundingClientRect(), readViewport())) {
    // 'instant' so a page-level `scroll-behavior: smooth` can't leave us mid-scroll.
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }
  host.setAttribute(HIDDEN_ATTR, '');
  try {
    await nextFrame();
    await nextFrame();
    const rect = clampRectToViewport(el.getBoundingClientRect(), readViewport());
    if (!rect) return undefined;
    const result = await withTimeout(
      sendToBackground({ type: 'wm:capture-element', rect, devicePixelRatio: window.devicePixelRatio || 1 }),
      CAPTURE_TIMEOUT_MS,
    );
    return result?.dataUrl;
  } finally {
    host.removeAttribute(HIDDEN_ATTR);
  }
}
