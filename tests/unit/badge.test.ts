import { expect, it } from 'vitest';
import { badgeText } from '@/lib/badge';

/* The toolbar badge counts a page's notes that still need work (open or in progress). */

it('shows the number of active notes', () => {
  expect(badgeText({ activeCount: 1 })).toBe('1');
  expect(badgeText({ activeCount: 12 })).toBe('12');
});

it('shows nothing when no note needs work, or for a malformed report', () => {
  expect(badgeText({ activeCount: 0 })).toBe('');
  expect(badgeText(undefined)).toBe('');
  for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null, undefined]) {
    expect(badgeText({ activeCount: bad as number })).toBe('');
  }
  expect(badgeText({ activeCount: 2.7 })).toBe('2');
});
