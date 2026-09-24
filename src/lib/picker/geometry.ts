export interface Box {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

const GAP = 6;
const MARGIN = 4;

function clamp(value: number, min: number, max: number): number {
  // When the tooltip is bigger than the viewport, pin it to the start edge.
  return Math.max(min, Math.min(value, max));
}

/**
 * Where to put the tooltip for a highlighted element, in viewport coordinates.
 * Prefers just above the element, then just below it, then inside its visible
 * top edge (for elements taller than the viewport); always inside the viewport.
 */
export function placeTooltip(target: Box, tip: Size, viewport: Size): Point {
  const above = target.top - GAP - tip.height;
  const below = target.bottom + GAP;
  let y: number;
  if (above >= MARGIN) y = above;
  else if (below + tip.height <= viewport.height - MARGIN) y = below;
  else y = Math.max(target.top, 0) + GAP;

  return {
    x: clamp(target.left, MARGIN, viewport.width - tip.width - MARGIN),
    y: clamp(y, MARGIN, viewport.height - tip.height - MARGIN),
  };
}

export function boxContains(box: Box, x: number, y: number): boolean {
  return x >= box.left && x < box.right && y >= box.top && y < box.bottom;
}
