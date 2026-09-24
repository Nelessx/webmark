import type { ViewportRect } from '@/lib/messages';

/*
 * Pure positioning maths for the in-page UI. Everything works in viewport
 * CSS pixels (getBoundingClientRect space) because the UI is position: fixed.
 */

export interface Size {
  width: number;
  height: number;
}

export interface RectLike {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Point {
  left: number;
  top: number;
}

export const PIN_SIZE = 24;
export const PIN_GAP = 4;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** The part of `rect` inside the viewport, or null if nothing is visible. */
export function clampRectToViewport(rect: RectLike, viewport: Size): ViewportRect | null {
  const x = Math.max(0, rect.left);
  const y = Math.max(0, rect.top);
  const right = Math.min(viewport.width, rect.left + rect.width);
  const bottom = Math.min(viewport.height, rect.top + rect.height);
  if (right - x < 1 || bottom - y < 1) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function isFullyInViewport(rect: RectLike, viewport: Size): boolean {
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.top + rect.height <= viewport.height &&
    rect.left + rect.width <= viewport.width
  );
}

export function intersectsViewport(rect: RectLike, viewport: Size): boolean {
  return (
    rect.top + rect.height > 0 &&
    rect.left + rect.width > 0 &&
    rect.top < viewport.height &&
    rect.left < viewport.width
  );
}

export type PopoverSide = 'right' | 'below' | 'left' | 'above' | 'overlap';

export interface PopoverPlacement extends Point {
  side: PopoverSide;
}

/**
 * Place a popover of `size` next to `target`, preferring the right side, then
 * below, left and above. The first side where it fits entirely wins; if none
 * fits (huge element or tiny viewport) it overlaps the element, clamped so it
 * always stays fully on screen.
 */
export function placePopover(
  target: RectLike,
  size: Size,
  viewport: Size,
  gap = 10,
  margin = 8,
): PopoverPlacement {
  const maxLeft = viewport.width - margin - size.width;
  const maxTop = viewport.height - margin - size.height;
  const clampLeft = (v: number) => clamp(v, margin, maxLeft);
  const clampTop = (v: number) => clamp(v, margin, maxTop);
  const fitsX = (left: number) => left >= margin && left <= maxLeft;
  const fitsY = (top: number) => top >= margin && top <= maxTop;
  const targetRight = target.left + target.width;
  const targetBottom = target.top + target.height;

  const candidates: Array<{ side: PopoverSide; left: number; top: number; fits: boolean }> = [
    { side: 'right', left: targetRight + gap, top: clampTop(target.top), fits: fitsX(targetRight + gap) && maxTop >= margin },
    { side: 'below', left: clampLeft(target.left), top: targetBottom + gap, fits: fitsY(targetBottom + gap) && maxLeft >= margin },
    {
      side: 'left',
      left: target.left - gap - size.width,
      top: clampTop(target.top),
      fits: fitsX(target.left - gap - size.width) && maxTop >= margin,
    },
    {
      side: 'above',
      left: clampLeft(target.left),
      top: target.top - gap - size.height,
      fits: fitsY(target.top - gap - size.height) && maxLeft >= margin,
    },
  ];
  const fit = candidates.find((c) => c.fits);
  if (fit) return { side: fit.side, left: fit.left, top: fit.top };
  return { side: 'overlap', left: clampLeft(targetRight - size.width - margin), top: clampTop(target.top + margin) };
}

/** Centre a box of `size` in the viewport (used when the target element is gone). */
export function centerInViewport(size: Size, viewport: Size, margin = 8): Point {
  return {
    left: clamp((viewport.width - size.width) / 2, margin, viewport.width - margin - size.width),
    top: clamp((viewport.height - size.height) / 3, margin, viewport.height - margin - size.height),
  };
}

/**
 * Positions for `count` pins on one element: a row whose last pin is centred
 * on the element's top-right corner, shifted as a whole to stay on screen.
 */
export function pinRowPositions(box: RectLike, count: number, viewport: Size, margin = 4): Point[] {
  if (count <= 0) return [];
  const step = PIN_SIZE + PIN_GAP;
  const rowWidth = count * PIN_SIZE + (count - 1) * PIN_GAP;
  const rowLeft = clamp(box.left + box.width - rowWidth + PIN_SIZE / 2, margin, viewport.width - margin - rowWidth);
  const top = clamp(box.top - PIN_SIZE / 2, margin, viewport.height - margin - PIN_SIZE);
  return Array.from({ length: count }, (_, i) => ({ left: rowLeft + i * step, top }));
}

export interface TooltipPlacement {
  left: number;
  top?: number;
  bottom?: number;
}

/**
 * Tooltip under a pin, or above it when the pin is near the bottom edge.
 * Vertical placement uses `bottom` in the "above" case so the tooltip's own
 * (unknown) height never needs measuring.
 */
export function placeTooltip(pin: Point, width: number, viewport: Size, estimatedHeight = 120, margin = 8): TooltipPlacement {
  const left = clamp(pin.left + PIN_SIZE / 2 - width / 2, margin, viewport.width - margin - width);
  const below = pin.top + PIN_SIZE + 6;
  if (below + estimatedHeight <= viewport.height - margin) return { left, top: below };
  return { left, bottom: viewport.height - pin.top + 6 };
}
