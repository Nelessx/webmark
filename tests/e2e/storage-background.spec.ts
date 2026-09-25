import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import type { Browser } from 'wxt/browser';
import type { Note } from '../../src/lib/types';
import { getPageKey } from '../../src/lib/url';
import { expect, test, type Extension } from './fixtures';
import { dashboard, openDashboard, WebMark } from './webmark';

/*
 * Storage hardening: the background is the only writer, screenshots live in
 * IndexedDB instead of storage.local, bulk actions write each page once,
 * imports are validated, and credentials in page addresses are redacted.
 */

/** The `chrome` global of an extension page or the service worker. Only valid inside evaluate() callbacks. */
declare const chrome: typeof Browser;

/** A complete note as WebMark stores it, on `url`, with an anchor that matches nothing. */
function noteFor(url: string, id: string, extra: Partial<Note> = {}): Note {
  const now = Date.now();
  return {
    id,
    schemaVersion: 1,
    pageKey: getPageKey(url),
    url,
    pageTitle: 'Seeded page',
    label: `Seeded ${id}`,
    body: `Body of ${id}`,
    status: 'open',
    tags: [],
    author: '',
    anchor: {
      selector: '#not-on-this-page',
      xpath: '/html/body/div[99]',
      tagName: 'div',
      classes: [],
      attributes: {},
      text: '',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      viewport: { width: 1280, height: 800 },
      ancestorTags: ['body'],
      nthOfType: 99,
    },
    hasScreenshot: false,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

interface StorageAnswer {
  ok?: boolean;
  value?: unknown;
  error?: string;
}

/** A storage request sent from an extension page, the way its own code sends one. */
function storageRequest(from: Page, op: string, args: unknown[]): Promise<StorageAnswer> {
  return from.evaluate(({ op, args }) => chrome.runtime.sendMessage({ type: 'wm:storage', op, args }), { op, args });
}

async function openExtensionPage(context: BrowserContext, ext: Extension, pathname: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(ext.url(pathname));
  return page;
}

/** The thumbnail of a note's card in the side panel or dashboard. */
function cardImage(page: Page, noteId: string) {
  return page.locator(`article[data-note-id="${noteId}"]`).getByRole('button', { name: /Enlarge screenshot/ }).locator('img');
}

const shotKeys = async (ext: Extension) => Object.keys(await ext.storage(null)).filter((key) => key.startsWith('wm:shot:'));

test.describe('storage in the background', () => {
  test('two contexts saving at once lose nothing: notes, pages and settings', async ({ context, page, ext, server }) => {
    const wm = new WebMark(page, ext);
    const urlA = server.url('/dashboard.html');
    const urlB = server.url('/widgets.html');
    await openDashboard(wm, urlA);
    const options = await openExtensionPage(context, ext, 'options.html');
    const panel = await openExtensionPage(context, ext, 'sidepanel.html');

    // Two pages fire 25 saves each at the same time, spread over two pages.
    const burst = (from: Page, prefix: string) =>
      from.evaluate(
        (notes) => Promise.all(notes.map((note) => chrome.runtime.sendMessage({ type: 'wm:storage', op: 'saveNote', args: [note] }))),
        Array.from({ length: 25 }, (_, i) => noteFor(i % 2 ? urlA : urlB, `${prefix}-${i}`)),
      );
    const answers = (await Promise.all([burst(options, 'options'), burst(panel, 'panel')])).flat() as StorageAnswer[];
    expect(answers.every((answer) => answer.ok)).toBe(true);
    expect((await ext.notes(getPageKey(urlA))).length + (await ext.notes(getPageKey(urlB))).length).toBe(50);
    expect(((await ext.storage('wm:pages'))['wm:pages'] as string[]).toSorted()).toEqual(
      [getPageKey(urlA), getPageKey(urlB)].toSorted(),
    );

    // The page's content script (pins switch) and the dashboard (author name) change settings at the same moment.
    for (const [round, visible] of [false, true, false].entries()) {
      await Promise.all([
        ext.send(page, { type: 'wm:set-pins-visible', visible }),
        storageRequest(options, 'saveSettings', [{ authorName: `Dana ${round}` }]),
      ]);
      expect(await ext.settings()).toMatchObject({ pinsVisible: visible, authorName: `Dana ${round}` });
    }
  });

  test('screenshots stay out of storage.local and still show in the side panel, dashboard and orphan card', async ({
    context,
    page,
    ext,
    server,
  }) => {
    const wm = new WebMark(page, ext);
    const url = server.url('/dashboard.html');
    await openDashboard(wm, url);
    const d = dashboard(page);
    const note = await wm.createNote(d.cardValue('Revenue'), 'Revenue needs its currency', { up: 1 });
    expect(note.hasScreenshot).toBe(true);
    const shot = await ext.screenshot(note.id);
    expect(shot).toMatch(/^data:image\/jpeg;base64,/);
    expect(await shotKeys(ext)).toEqual([]);

    // The side panel follows the active tab.
    const panel = await openExtensionPage(context, ext, 'sidepanel.html');
    await page.bringToFront();
    await expect(cardImage(panel, note.id)).toHaveAttribute('src', shot!);

    const options = await openExtensionPage(context, ext, 'options.html');
    await expect(cardImage(options, note.id)).toHaveAttribute('src', shot!);

    // The page's "not on the page" card: its content script asks the background for the image.
    await page.bringToFront();
    await openDashboard(wm, url, 'removed');
    expect(await ext.send(page, { type: 'wm:focus-note', noteId: note.id })).toEqual({ found: false });
    await expect(page.locator(`[data-wm-orphan-card="${note.id}"] img`)).toHaveAttribute('src', shot!);

    // Deleting the note deletes its screenshot.
    await options.bringToFront();
    await options.locator(`article[data-note-id="${note.id}"]`).getByRole('button', { name: 'Delete note' }).click();
    await options.locator(`article[data-note-id="${note.id}"]`).getByRole('button', { name: 'Delete?' }).click();
    await expect.poll(() => ext.screenshot(note.id)).toBeUndefined();
  });

  test('an update moves screenshots stored under wm:shot:* keys into IndexedDB', async ({ context, ext, server }) => {
    const scratch = await openExtensionPage(context, ext, 'options.html');
    const jpeg = await scratch.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 60;
      canvas.height = 30;
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#d33';
      g.fillRect(0, 0, 60, 30);
      return canvas.toDataURL('image/jpeg', 0.9);
    });
    await scratch.close();
    // What the previous version stored.
    const note = noteFor(server.url('/dashboard.html'), 'legacy-note', { hasScreenshot: true });
    await (await ext.worker()).evaluate(
      ({ note, jpeg }) =>
        chrome.storage.local.set({
          'wm:pages': [note.pageKey],
          [`wm:notes:${note.pageKey}`]: [note],
          [`wm:shot:${note.id}`]: jpeg,
        }),
      { note, jpeg },
    );
    expect(await ext.storage('wm:storage-version')).toEqual({});

    await ext.reloadExtension();

    await expect
      .poll(async () => Object.keys(await ext.storage(null)).toSorted(), { timeout: 15_000 })
      .toEqual([`wm:notes:${note.pageKey}`, 'wm:pages', 'wm:storage-version']);
    expect(await ext.storage('wm:storage-version')).toEqual({ 'wm:storage-version': 2 });
    expect(await ext.screenshot(note.id)).toBe(jpeg);
    const options = await openExtensionPage(context, ext, 'options.html');
    await expect(cardImage(options, note.id)).toHaveAttribute('src', jpeg);
  });

  test('bulk resolve in the dashboard writes each page once', async ({ context, ext, server }) => {
    const options = await openExtensionPage(context, ext, 'options.html');
    const urlA = server.url('/dashboard.html');
    const urlB = server.url('/widgets.html');
    const notes = [1, 2, 3].map((i) => noteFor(urlA, `a${i}`)).concat([1, 2].map((i) => noteFor(urlB, `b${i}`)));
    expect(await storageRequest(options, 'bulkPutNotes', [notes])).toMatchObject({ ok: true });
    const cards = options.locator('article.wm-note-card');
    await expect(cards).toHaveCount(5);

    // Every storage change the dashboard sees from here on (open tabs get the same ones).
    await options.evaluate(() => {
      const seen: string[][] = [];
      (window as unknown as { __changes: string[][] }).__changes = seen;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') seen.push(Object.keys(changes));
      });
    });
    await cards.first().getByRole('checkbox').check();
    const bulk = options.getByRole('toolbar', { name: 'Bulk actions' });
    await bulk.getByRole('button', { name: 'Select all 5' }).click();
    await bulk.getByRole('button', { name: 'Resolve' }).click();
    await expect(options.getByText('5 notes · 0 open · 2 pages')).toBeVisible();

    const changes = await options.evaluate(() => (window as unknown as { __changes: string[][] }).__changes);
    const writesOf = (url: string) => changes.filter((keys) => keys.includes(`wm:notes:${getPageKey(url)}`)).length;
    expect(writesOf(urlA)).toBe(1);
    expect(writesOf(urlB)).toBe(1);
    expect([...(await ext.notes(getPageKey(urlA))), ...(await ext.notes(getPageKey(urlB)))].map((n) => n.status)).toEqual(
      Array(5).fill('resolved'),
    );
  });

  test('import refuses a file whose note shows one site but links to another', async ({ context, ext }) => {
    const options = await openExtensionPage(context, ext, 'options.html');
    const phishing = {
      ...noteFor('https://evil.example/login', 'phish'),
      pageKey: 'https://bank.example/account',
      pageTitle: 'Your bank',
    };
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'webmark-import-')), 'shared-notes.json');
    await writeFile(file, JSON.stringify({ format: 'webmark', version: 1, exportedAt: 0, notes: [phishing], screenshots: {} }));

    await options.locator('input[type="file"]').setInputFiles(file);

    await expect(options.getByText("Note 1 has a 'pageKey' that does not match its 'url'.")).toBeVisible();
    await expect(options.getByText('No notes yet')).toBeVisible();
    expect(Object.keys(await ext.storage(null)).filter((key) => key.startsWith('wm:notes:'))).toEqual([]);
  });

  test('tokens in page addresses reach neither storage nor an exported report', async ({ context, page, ext, server }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html?view=kpis&token=magic-link-secret#access_token=oauth-secret'));
    const note = await wm.createNote(dashboard(page).cardValue('Revenue'), 'Shared through a magic link', { up: 1 });
    expect(note.pageKey).toBe(server.url('/dashboard.html?view=kpis'));
    expect(note.url).toBe(server.url('/dashboard.html?view=kpis&token=REDACTED#access_token=REDACTED'));

    // A note saved by an earlier version, token and all.
    const legacyUrl = server.url('/widgets.html?token=legacy-secret');
    const legacy = { ...noteFor(legacyUrl, 'legacy'), pageKey: legacyUrl, pageTitle: 'Widgets' };
    await (await ext.worker()).evaluate(async (legacy) => {
      const pages = ((await chrome.storage.local.get('wm:pages'))['wm:pages'] as string[] | undefined) ?? [];
      await chrome.storage.local.set({ 'wm:pages': [...pages, legacy.pageKey], [`wm:notes:${legacy.pageKey}`]: [legacy] });
    }, legacy);

    const options = await openExtensionPage(context, ext, 'options.html');
    await expect(options.locator('article.wm-note-card')).toHaveCount(2);
    const exported = async (kind: string) => {
      await options.getByRole('combobox', { name: 'Export format' }).selectOption(kind);
      const download = options.waitForEvent('download');
      await options.getByRole('button', { name: 'Export all' }).click();
      return readFile(await (await download).path(), 'utf8');
    };

    const report = await exported('markdown');
    expect(report).toContain(server.url('/dashboard.html?view=kpis&token=REDACTED#access_token=REDACTED'));
    expect(report).toContain(server.url('/widgets.html?token=REDACTED'));
    for (const text of [report, await exported('csv'), await exported('json-lite')]) {
      expect(text).not.toMatch(/magic-link-secret|oauth-secret|legacy-secret/);
    }
  });
});

test.describe('background: context menu and "Open on page"', () => {
  test('a right-click the page fakes cannot choose the element to annotate', async ({ page, ext, server }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);

    await d.rowCustomer(3).evaluate((el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true })));
    expect(await ext.send(page, { type: 'wm:note-from-context-menu' })).toEqual({ ok: true });
    // Only real input counts, so the menu item falls back to the picker.
    await expect(wm.pickerHint).toBeVisible();
    await expect(wm.editor()).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(wm.pickerHint).toBeHidden();

    // A real right-click, then another press: the menu this tracker saw is gone.
    await d.rowCustomer(3).click({ button: 'right' });
    await d.rowCustomer(4).click({ button: 'middle' });
    expect(await ext.send(page, { type: 'wm:note-from-context-menu' })).toEqual({ ok: true });
    await expect(wm.pickerHint).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('"Open on page" injects WebMark into a tab without it instead of reloading the tab', async ({
    context,
    page,
    ext,
    server,
    errorLog,
  }) => {
    // An XML document: the content script declines it, so the tab has none (like a tab opened before install).
    const url = server.url('/feed.xml');
    await page.goto(url);
    await page.evaluate(() => ((window as unknown as { __marker: string }).__marker = 'still here'));
    await expect(ext.pageState(page)).rejects.toThrow();

    const options = await openExtensionPage(context, ext, 'options.html');
    const note = noteFor(url, 'feed-note');
    expect(await storageRequest(options, 'saveNote', [note])).toMatchObject({ ok: true });
    const tabs = context.pages().length;
    await options.locator(`article[data-note-id="${note.id}"]`).getByRole('button', { name: 'Open on page', exact: true }).click();

    // The injected script reveals the note once it has loaded; here it declines the page again.
    await expect
      .poll(async () => (await ext.storage('wm:pending-focus'))['wm:pending-focus'])
      .toMatchObject({ pageKey: note.pageKey, noteId: note.id });
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
    expect(await page.evaluate(() => (window as unknown as { __marker?: string }).__marker)).toBe('still here');
    expect(context.pages()).toHaveLength(tabs);
    await expect(options.getByText("Couldn't show this note on its page")).toBeHidden();

    // Known and unrelated: React DOM throws while loading in an XML document (its vendor-prefix
    // check reads document.createElement('div').style, which XML elements lack), so the content
    // script logs a page error there each time it loads.
    const onXmlPage = (error: string) => error.includes(`on ${url}:`) && error.includes("search for 'animation'");
    errorLog.errors.splice(0, errorLog.errors.length, ...errorLog.errors.filter((error) => !onXmlPage(error)));
  });
});
