import { describe, expect, it } from 'vitest';
import {
  PIN_GAP,
  PIN_SIZE,
  centerInViewport,
  clampRectToViewport,
  isFullyInViewport,
  pinRowPositions,
  placePopover,
  placeTooltip,
} from '@/entrypoints/content/geometry';

const viewport = { width: 1000, height: 800 };
const popover = { width: 300, height: 200 };

describe('clampRectToViewport', () => {
  it('keeps a rect that is fully visible', () => {
    expect(clampRectToViewport({ left: 10, top: 20, width: 100, height: 50 }, viewport)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it('crops the parts outside the viewport', () => {
    expect(clampRectToViewport({ left: -50, top: 700, width: 200, height: 300 }, viewport)).toEqual({
      x: 0,
      y: 700,
      width: 150,
      height: 100,
    });
  });

  it('returns null when nothing is visible', () => {
    expect(clampRectToViewport({ left: 0, top: 900, width: 100, height: 100 }, viewport)).toBeNull();
    expect(clampRectToViewport({ left: 10, top: 10, width: 0, height: 0 }, viewport)).toBeNull();
  });
});

describe('isFullyInViewport', () => {
  it('detects partial visibility', () => {
    expect(isFullyInViewport({ left: 0, top: 0, width: 1000, height: 800 }, viewport)).toBe(true);
    expect(isFullyInViewport({ left: 0, top: -1, width: 10, height: 10 }, viewport)).toBe(false);
    expect(isFullyInViewport({ left: 995, top: 0, width: 10, height: 10 }, viewport)).toBe(false);
  });
});

describe('placePopover', () => {
  it('prefers the right side, aligned with the top of the element', () => {
    const place = placePopover({ left: 100, top: 100, width: 200, height: 50 }, popover, viewport);
    expect(place).toEqual({ side: 'right', left: 310, top: 100 });
  });

  it('goes below when there is no room on the right', () => {
    const place = placePopover({ left: 600, top: 100, width: 300, height: 50 }, popover, viewport);
    expect(place.side).toBe('below');
    expect(place.top).toBe(160);
    expect(place.left + popover.width).toBeLessThanOrEqual(viewport.width - 8);
  });

  it('flips to the left, then above', () => {
    expect(placePopover({ left: 600, top: 500, width: 350, height: 250 }, popover, viewport).side).toBe('left');
    expect(placePopover({ left: 100, top: 500, width: 850, height: 250 }, popover, viewport).side).toBe('above');
  });

  it('overlaps but stays fully on screen for elements larger than the viewport', () => {
    const place = placePopover({ left: -10, top: -10, width: 1100, height: 900 }, popover, viewport);
    expect(place.side).toBe('overlap');
    expect(place.left).toBeGreaterThanOrEqual(8);
    expect(place.top).toBeGreaterThanOrEqual(8);
    expect(place.left + popover.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(place.top + popover.height).toBeLessThanOrEqual(viewport.height - 8);
  });

  it('clamps vertically when the element is scrolled above the viewport', () => {
    const place = placePopover({ left: 100, top: -400, width: 200, height: 50 }, popover, viewport);
    expect(place.side).toBe('right');
    expect(place.top).toBe(8);
  });
});

describe('centerInViewport', () => {
  it('centres horizontally and sits in the upper third', () => {
    expect(centerInViewport(popover, viewport)).toEqual({ left: 350, top: 200 });
  });
});

describe('pinRowPositions', () => {
  it('centres a single pin on the top-right corner', () => {
    const [pin] = pinRowPositions({ left: 100, top: 100, width: 200, height: 50 }, 1, viewport);
    expect(pin).toEqual({ left: 300 - PIN_SIZE / 2, top: 100 - PIN_SIZE / 2 });
  });

  it('lays several pins out in a row ending at the corner', () => {
    const pins = pinRowPositions({ left: 100, top: 100, width: 200, height: 50 }, 3, viewport);
    expect(pins).toHaveLength(3);
    expect(pins[2]?.left).toBe(300 - PIN_SIZE / 2);
    expect(pins[1]?.left).toBe(300 - PIN_SIZE / 2 - (PIN_SIZE + PIN_GAP));
    expect(new Set(pins.map((p) => p.top)).size).toBe(1);
  });

  it('keeps the whole row inside the viewport', () => {
    const pins = pinRowPositions({ left: 900, top: -30, width: 100, height: 20 }, 2, viewport);
    const last = pins[pins.length - 1];
    expect(pins[0]?.top).toBe(4);
    expect(last && last.left + PIN_SIZE).toBeLessThanOrEqual(viewport.width - 4);
  });
});

describe('placeTooltip', () => {
  it('shows below the pin, or above near the bottom edge', () => {
    expect(placeTooltip({ left: 500, top: 100 }, 260, viewport)).toMatchObject({ top: 100 + PIN_SIZE + 6 });
    const above = placeTooltip({ left: 500, top: 760 }, 260, viewport);
    expect(above.top).toBeUndefined();
    expect(above.bottom).toBe(800 - 760 + 6);
  });

  it('clamps horizontally', () => {
    expect(placeTooltip({ left: 990, top: 100 }, 260, viewport).left).toBe(1000 - 8 - 260);
    expect(placeTooltip({ left: 0, top: 100 }, 260, viewport).left).toBe(8);
  });
});
