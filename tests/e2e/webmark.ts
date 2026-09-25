import type { Locator, Page } from '@playwright/test';
import type { Note } from '../../src/lib/types';
import { expect, type Extension } from './fixtures';

/*
 * Drives WebMark's in-page UI the way a user does: real mouse and keyboard
 * input. Things Playwright can't reach (toolbar button, keyboard shortcut,
 * context menu item) are replaced by the message the background would send.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function rectOf(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${locator} is not rendered`);
  return box;
}

/** Largest difference between two rectangles' edges, in CSS px. */
export function rectDistance(a: Rect | null, b: Rect | null): number {
  if (!a || !b) return Infinity;
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - (b.x + b.width)),
    Math.abs(a.y + a.height - (b.y + b.height)),
  );
}

/**
 * After a click confirms a pick, the picker swallows page clicks for this
 * long (the rest of a double-click must not reach the page), see
 * TRAILING_POINTER in src/lib/picker/controller.ts.
 */
const PICK_CLICK_GUARD_MS = 500;

export class WebMark {
  private lastClickPick = 0;

  constructor(
    readonly page: Page,
    readonly ext: Extension,
  ) {}

  /**
   * Wait out the picker's trailing-click guard before clicking the page. Only
   * tests need this: nobody picks, writes and saves a note within half a second.
   */
  async waitForClickGuard(): Promise<void> {
    const remaining = this.lastClickPick + PICK_CLICK_GUARD_MS + 50 - Date.now();
    if (remaining > 0) await this.page.waitForTimeout(remaining);
  }

  get host(): Locator {
    return this.page.locator('webmark-ui');
  }

  editor(mode?: 'create' | 'edit'): Locator {
    return this.page.locator(mode ? `[data-wm-editor="${mode}"]` : '[data-wm-editor]');
  }

  get pins(): Locator {
    return this.page.locator('[data-wm-pin]');
  }

  pin(noteId: string): Locator {
    return this.page.locator(`[data-wm-pin="${noteId}"]`);
  }

  get pickerBox(): Locator {
    return this.page.locator('.wm-picker-box');
  }

  get pickerLabel(): Locator {
    return this.page.locator('.wm-picker-tip-label');
  }

  get pickerHint(): Locator {
    return this.page.locator('.wm-picker-hint');
  }

  /** Navigate and wait for the content script to answer for the new page. */
  async open(url: string): Promise<void> {
    await this.page.goto(url);
    await this.ext.waitForContentScript(this.page);
  }

  /** Reload and wait for the (new) content script. */
  async reload(): Promise<void> {
    await this.page.reload();
    await this.ext.waitForContentScript(this.page);
  }

  /** What the Alt+Shift+M command / popup "Add note" button do. */
  async startPicker(): Promise<void> {
    await this.page.bringToFront();
    expect(await this.ext.send(this.page, { type: 'wm:start-picker' })).toEqual({ ok: true });
    await expect(this.pickerHint).toBeVisible();
  }

  /** Move the mouse to the centre of `target` (scrolled into view first) and return the point. */
  async hover(target: Locator): Promise<{ x: number; y: number }> {
    await target.scrollIntoViewIfNeeded();
    const box = await rectOf(target);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await this.page.mouse.move(point.x, point.y);
    return point;
  }

  /** The picker's highlight box sits exactly on `target`. */
  async expectHighlighted(target: Locator): Promise<void> {
    await expect
      .poll(async () => rectDistance(await this.pickerBox.boundingBox(), await target.boundingBox()), {
        message: `picker highlight on ${target}`,
      })
      .toBeLessThanOrEqual(1.5);
  }

  /**
   * Hover `target`, press ArrowUp `up` times (then expect the highlight on
   * `expected`, if given) and click where the pointer is.
   */
  async pick(target: Locator, options: { up?: number; expected?: Locator } = {}): Promise<void> {
    const point = await this.hover(target);
    await this.expectHighlighted(target);
    for (let i = 0; i < (options.up ?? 0); i++) await this.page.keyboard.press('ArrowUp');
    if (options.expected) await this.expectHighlighted(options.expected);
    await this.confirmPick(point);
  }

  /** Click to confirm the highlighted element; the picker then guards against trailing clicks. */
  async confirmPick(point: { x: number; y: number }): Promise<void> {
    await this.page.mouse.click(point.x, point.y);
    this.lastClickPick = Date.now();
    await expect(this.pickerHint).toBeHidden();
  }

  /** Which editor field has focus inside WebMark's shadow root. */
  async focusedField(): Promise<string | null> {
    return this.page.evaluate(() => {
      const active = document.querySelector('webmark-ui')?.shadowRoot?.activeElement;
      if (!active) return null;
      return ['data-wm-body', 'data-wm-label', 'data-wm-tags'].find((a) => active.hasAttribute(a)) ?? active.localName;
    });
  }

  /** Type a note into the open editor (it focuses the text box itself) and save with Ctrl+Enter. */
  async write(body: string, options: { tags?: string } = {}): Promise<void> {
    const editor = this.editor();
    await expect(editor).toBeVisible();
    await expect.poll(() => this.focusedField(), { message: 'editor focuses the note field' }).toBe('data-wm-body');
    await this.page.keyboard.type(body);
    if (options.tags) {
      await editor.locator('[data-wm-tags]').click();
      await this.page.keyboard.type(options.tags);
    }
    await this.page.keyboard.press('Control+Enter');
    await expect(editor).toBeHidden();
  }

  /** Picker → pick → write → save. Returns the stored note. */
  async createNote(target: Locator, body: string, options: { up?: number; expected?: Locator; tags?: string } = {}): Promise<Note> {
    const before = new Set((await this.ext.notes(this.page)).map((n) => n.id));
    await this.startPicker();
    await this.pick(target, options);
    await this.write(body, options);
    let created: Note | undefined;
    await expect
      .poll(async () => {
        created = (await this.ext.notes(this.page)).find((n) => !before.has(n.id));
        return created?.body;
      })
      .toBe(body);
    return created as Note;
  }

  /**
   * The pin for `noteId` is shown with its centre on the top-right corner of
   * `target`. The target is scrolled to mid-screen first: pins are clamped
   * inside the viewport, so a corner at the very edge moves its pin.
   */
  async expectPinOn(noteId: string, target: Locator): Promise<void> {
    await target.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    const pin = this.pin(noteId);
    await expect(pin).toBeVisible();
    await expect
      .poll(
        async () => {
          const p = await pin.boundingBox();
          const t = await target.boundingBox();
          if (!p || !t) return Infinity;
          return Math.max(Math.abs(p.x + p.width / 2 - (t.x + t.width)), Math.abs(p.y + p.height / 2 - t.y));
        },
        { message: `pin ${noteId} on the top-right corner of ${target}` },
      )
      .toBeLessThanOrEqual(2);
  }

  async pageValue<T>(name: string): Promise<T> {
    return this.page.evaluate((n) => (window as unknown as Record<string, T>)[n] as T, name);
  }
}

/** Padding the extension adds around an element screenshot, see CROP_PADDING_CSS_PX in src/lib/capture.ts. */
const CROP_PADDING = 8;

export interface ScreenshotReport {
  /** Screenshot size in CSS px. */
  width: number;
  height: number;
  /** The element plus padding, cut to the viewport, in CSS px. */
  expectedWidth: number;
  expectedHeight: number;
  /** RGB just left of the element (page background). */
  outside: number[];
  /** RGB inside the element, near its right edge (element background). */
  inside: number[];
}

/**
 * Decode a stored screenshot in the page and compare it with where `element`
 * is now (it must not have moved since the capture).
 */
export async function inspectScreenshot(page: Page, src: string, element: Rect): Promise<ScreenshotReport> {
  return page.evaluate(
    async ({ src, element, pad }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const g = canvas.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const dpr = devicePixelRatio;
      const { clientWidth, clientHeight } = document.documentElement;
      const left = Math.max(0, element.x - pad);
      const top = Math.max(0, element.y - pad);
      const right = Math.min(clientWidth, element.x + element.width + pad);
      const bottom = Math.min(clientHeight, element.y + element.height + pad);
      // Sample points in page coordinates, read from the screenshot.
      const pixel = (x: number, y: number) => [
        ...g.getImageData(Math.round((x - left) * dpr), Math.round((y - top) * dpr), 1, 1).data.slice(0, 3),
      ];
      const middle = Math.max(top, element.y) + (Math.min(bottom, element.y + element.height) - Math.max(top, element.y)) / 2;
      return {
        width: img.naturalWidth / dpr,
        height: img.naturalHeight / dpr,
        expectedWidth: right - left,
        expectedHeight: bottom - top,
        outside: pixel(element.x - 4, middle),
        inside: pixel(element.x + element.width - 20, middle),
      };
    },
    { src, element, pad: CROP_PADDING },
  );
}

/** Each channel within `tolerance` of the expected colour (JPEG is lossy). */
export function nearColor(rgb: number[], expected: number[], tolerance = 8): boolean {
  return rgb.length === expected.length && rgb.every((v, i) => Math.abs(v - (expected[i] ?? 0)) <= tolerance);
}

/** Dashboard page landmarks, located by content (class names change in the "shifted" variant). */
export function dashboard(page: Page) {
  const card = (title: string) => page.getByRole('heading', { level: 3, name: title, exact: true }).locator('xpath=..');
  const row = (n: number) => page.getByRole('listitem').filter({ hasText: `ORD-${1000 + n}` });
  return {
    card,
    cardValue: (title: string) => card(title).locator('p'),
    details: (title: string) => card(title).getByRole('button', { name: 'Details' }),
    row,
    rowCustomer: (n: number) => row(n).getByText(`Customer ${n}`, { exact: true }),
    cards: page.getByRole('heading', { level: 3 }).locator('xpath=..'),
  };
}

/** Load the dashboard in a given variant (stored in the page's localStorage, so the URL and page key stay the same). */
export async function openDashboard(wm: WebMark, url: string, variant?: 'live' | 'shifted' | 'removed'): Promise<void> {
  await wm.open(url);
  const current = await wm.page.evaluate(() => localStorage.getItem('variant'));
  if ((current ?? undefined) === variant) return;
  await wm.page.evaluate((v) => (v ? localStorage.setItem('variant', v) : localStorage.removeItem('variant')), variant ?? null);
  await wm.reload();
  expect(await wm.pageValue<string>('__variant')).toBe(variant ?? 'base');
}
