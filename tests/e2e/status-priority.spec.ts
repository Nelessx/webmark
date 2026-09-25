import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { Browser } from 'wxt/browser';
import type { ExportBundle } from '../../src/lib/export';
import { NOTE_SCHEMA_VERSION, type Note, type NotePriority, type NoteStatus } from '../../src/lib/types';
import { getPageKey } from '../../src/lib/url';
import { expect, test, type Extension } from './fixtures';
import { dashboard, openDashboard, WebMark } from './webmark';

/*
 * Four statuses (Open, In progress, Completed, Archived) and three priorities
 * (Low, Medium, High) across the page, the side panel, the popup, the All
 * notes page and the toolbar badge.
 */

/** The `chrome` global of an extension page or the service worker. Only valid inside evaluate() callbacks. */
declare const chrome: typeof Browser;

/** The blue of an in-progress pin (--wm-pin-in-progress) and the red of the high-priority dot (--wm-pin-high). */
const PIN_IN_PROGRESS = 'rgb(37, 99, 235)';
const PIN_HIGH_DOT = 'rgb(224, 68, 74)';

/** A complete note on `url` whose anchor matches nothing there. */
function seeded(url: string, id: string, status: NoteStatus, priority: NotePriority, createdAt: number): Note {
  return {
    id,
    schemaVersion: NOTE_SCHEMA_VERSION,
    pageKey: getPageKey(url),
    url,
    pageTitle: 'Seeded page',
    label: `Seeded ${id}`,
    body: `Body of ${id}`,
    status,
    priority,
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
    createdAt,
    updatedAt: createdAt,
  };
}

async function openExtensionPage(page: Page, ext: Extension, pathname: string): Promise<Page> {
  const opened = await page.context().newPage();
  await opened.goto(ext.url(pathname));
  return opened;
}

/** Save through the background, the way WebMark's own pages do. */
async function seed(from: Page, notes: Note[]): Promise<void> {
  const answer = await from.evaluate((list) => chrome.runtime.sendMessage({ type: 'wm:storage', op: 'bulkPutNotes', args: [list] }), notes);
  expect(answer).toMatchObject({ ok: true });
}

test.describe('statuses and priorities', () => {
  test('priority in the isolated editor, status from the side panel: pins, filters and the badge follow', async ({
    page,
    ext,
    server,
  }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);

    // A new note in the isolated editor: Medium until High is chosen, and no status to pick (it starts open).
    await wm.startPicker();
    await wm.pick(d.cardValue('Revenue'), { up: 1, expected: d.card('Revenue') });
    const editor = wm.editor('create');
    await expect(editor).toBeVisible();
    await expect(editor.locator('[data-wm-status]')).toHaveCount(0);
    const priority = editor.getByRole('radiogroup', { name: 'Priority' });
    await expect(priority.getByRole('radio')).toHaveText(['Low', 'Medium', 'High']);
    await expect(priority.getByRole('radio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true');
    await priority.getByRole('radio', { name: 'High' }).click();
    await expect(priority.getByRole('radio', { name: 'High' })).toHaveAttribute('aria-checked', 'true');
    await editor.locator('[data-wm-body]').click();
    await page.keyboard.type('Revenue must include refunds');
    await page.keyboard.press('Control+Enter');
    await expect(editor).toBeHidden();

    let note: Note | undefined;
    await expect
      .poll(async () => {
        note = (await ext.notes(page)).find((n) => n.body === 'Revenue must include refunds');
        return note && [note.status, note.priority];
      })
      .toEqual(['open', 'high']);
    const id = note!.id;

    // The pin carries the red high-priority dot.
    await wm.expectPinOn(id, d.card('Revenue'));
    const pin = wm.pin(id);
    await expect(pin).toHaveAttribute('data-status', 'open');
    await expect(pin).toHaveAttribute('data-priority', 'high');
    expect(
      await pin.evaluate((el) => {
        const dot = getComputedStyle(el, '::after');
        return [dot.content, dot.width, dot.backgroundColor];
      }),
    ).toEqual(['""', '9px', PIN_HIGH_DOT]);
    await pin.hover();
    await expect(page.locator(`[data-wm-tooltip="${id}"]`)).toContainText('Open');
    await expect(page.locator(`[data-wm-tooltip="${id}"]`)).toContainText('High priority');
    await page.mouse.move(0, 0);

    const other = await wm.createNote(d.cardValue('Users'), 'Users means monthly actives', { up: 1 });
    expect(other.priority).toBe('medium');
    expect(await wm.pin(other.id).getAttribute('data-priority')).toBe('medium');
    await expect.poll(() => ext.badgeText(page)).toBe('2');

    // The side panel follows the active tab.
    const panel = await openExtensionPage(page, ext, 'sidepanel.html');
    await page.bringToFront();
    const card = panel.locator(`article[data-note-id="${id}"]`);
    await expect(card.getByRole('button', { name: 'Priority: High' })).toBeVisible();

    // In progress: the pin turns blue right away, and the badge still counts the note.
    // (The panel's tab is in the background, where Playwright's clicks wait for frames that
    // never come; from here on the panel is driven from the keyboard, as some people use it.)
    await card.getByRole('button', { name: 'Status: Open' }).click();
    await expect(panel.getByRole('menu', { name: 'Status' })).toBeVisible();
    // The menu opens on the current status.
    await expect(panel.getByRole('menuitemradio', { name: 'Open' })).toBeFocused();
    await panel.keyboard.press('ArrowDown');
    await expect(panel.getByRole('menuitemradio', { name: 'In progress' })).toBeFocused();
    await panel.keyboard.press('Enter');
    await expect(panel.getByRole('menu')).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Status: In progress' })).toBeFocused();
    await expect.poll(async () => (await ext.note(page, id))?.status).toBe('in_progress');
    await expect(pin).toHaveAttribute('data-status', 'in_progress');
    await expect.poll(() => pin.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(PIN_IN_PROGRESS);
    await expect(card.getByRole('button', { name: 'Status: In progress' })).toBeVisible();
    expect((await ext.pageState(page)).statusCounts).toEqual({ open: 1, in_progress: 1, completed: 0, archived: 0 });
    await expect.poll(() => ext.badgeText(page)).toBe('2');

    // Completed (the card's one-click next step): the badge counts down.
    await card.getByRole('button', { name: 'Complete', exact: true }).press('Enter');
    await expect.poll(async () => (await ext.note(page, id))?.status).toBe('completed');
    await expect(pin).toHaveAttribute('data-status', 'completed');
    await expect.poll(() => ext.badgeText(page)).toBe('1');

    // Archived: the pin goes, "All" leaves the note out, "Archived" lists it.
    const cards = panel.locator('article.wm-note-card');
    const statusFilter = panel.getByRole('radiogroup', { name: 'Filter by status' });
    await expect(statusFilter.getByRole('radio')).toHaveText(['All 2', 'Open 1', 'In progress 0', 'Completed 1', 'Archived 0']);
    await card.getByRole('button', { name: 'Status: Completed' }).press('ArrowDown');
    await expect(panel.getByRole('menuitemradio', { name: 'Completed' })).toBeFocused();
    await panel.getByRole('menuitemradio', { name: 'Archived' }).press('Enter');
    await expect.poll(async () => (await ext.note(page, id))?.status).toBe('archived');
    await expect(pin).toHaveCount(0);
    // Pin numbers don't move: #2 is still #2.
    await expect(wm.pin(other.id)).toHaveText('2');
    await expect(wm.pins).toHaveCount(1);
    expect((await ext.pageState(page)).orphanedIds).toEqual([]);
    await expect.poll(() => ext.badgeText(page)).toBe('1');
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute('data-note-id', other.id);
    await expect(statusFilter.getByRole('radio')).toHaveText(['All 1', 'Open 1', 'In progress 0', 'Completed 0', 'Archived 1']);
    await statusFilter.getByRole('radio', { name: /Archived/ }).press('Enter');
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute('data-note-id', id);

    // The priority filter works together with the status filter.
    const priorityFilter = panel.getByRole('radiogroup', { name: 'Filter by priority' });
    await expect(priorityFilter.getByRole('radio')).toHaveText(['All 1', 'High 1', 'Medium 0', 'Low 0']);
    await priorityFilter.getByRole('radio', { name: /Medium/ }).press('Enter');
    await expect(cards).toHaveCount(0);
    await panel.getByRole('button', { name: 'Clear filters' }).first().press('Enter');
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute('data-note-id', other.id);

    // Unarchived, its pin is back with its old number.
    await statusFilter.getByRole('radio', { name: /Archived/ }).press('Enter');
    await card.getByRole('button', { name: 'Unarchive' }).press('Enter');
    await expect.poll(async () => (await ext.note(page, id))?.status).toBe('open');
    await expect(pin).toHaveText('1');
    await expect.poll(() => ext.badgeText(page)).toBe('2');
  });

  test('All notes: filter by status and priority, sort by priority, bulk-set priority and status, export what is shown', async ({
    page,
    ext,
    server,
  }) => {
    const url = server.url('/dashboard.html');
    const options = await openExtensionPage(page, ext, 'options.html');
    await seed(options, [
      seeded(url, 'a1', 'open', 'low', 1),
      seeded(url, 'a2', 'open', 'high', 2),
      seeded(url, 'a3', 'in_progress', 'high', 3),
      seeded(url, 'a4', 'completed', 'medium', 4),
      seeded(url, 'a5', 'archived', 'high', 5),
    ]);
    const cards = options.locator('article.wm-note-card');
    const shown = () => cards.evaluateAll((list) => list.map((el) => el.getAttribute('data-note-id')));
    await expect(cards).toHaveCount(4);
    expect(await shown()).toEqual(['a1', 'a2', 'a3', 'a4']);
    const summary = options.getByRole('list', { name: 'Summary' });
    await expect(summary.getByRole('listitem')).toHaveText(['2 open', '1 in progress', '1 completed', '1 archived', '2 high priority']);

    // Status and priority filters, with counts that follow each other.
    const status = options.getByRole('radiogroup', { name: 'Filter by status' });
    const priority = options.getByRole('radiogroup', { name: 'Filter by priority' });
    await expect(status.getByRole('radio')).toHaveText(['All 4', 'Open 2', 'In progress 1', 'Completed 1', 'Archived 1']);
    await expect(priority.getByRole('radio')).toHaveText(['All 4', 'High 2', 'Medium 1', 'Low 1']);
    await priority.getByRole('radio', { name: /High/ }).click();
    expect(await shown()).toEqual(['a2', 'a3']);
    await expect(status.getByRole('radio')).toHaveText(['All 2', 'Open 1', 'In progress 1', 'Completed 0', 'Archived 1']);
    await status.getByRole('radio', { name: /In progress/ }).click();
    expect(await shown()).toEqual(['a3']);
    await status.getByRole('radio', { name: /Archived/ }).click();
    expect(await shown()).toEqual(['a5']);
    await options.getByRole('button', { name: 'Clear filters' }).first().click();
    expect(await shown()).toEqual(['a1', 'a2', 'a3', 'a4']);

    // Sorting within the page: high first (ties by pin), newest first, back to pin order.
    const sort = options.getByRole('combobox', { name: 'Sort notes on each page' });
    await sort.selectOption('priority');
    await expect.poll(shown).toEqual(['a2', 'a3', 'a4', 'a1']);
    await sort.selectOption('newest');
    await expect.poll(shown).toEqual(['a4', 'a3', 'a2', 'a1']);
    await sort.selectOption('pin');
    await expect.poll(shown).toEqual(['a1', 'a2', 'a3', 'a4']);
    // Pin numbers stay those of the page, archived note included.
    await expect(options.locator('article[data-note-id="a4"] .wm-pin')).toHaveText('4');

    // Exports: a report holds what is shown (no archived note), a backup holds everything.
    const exportButton = options.getByRole('button', { name: /^Export (all|\d+ shown)$/ });
    await expect(exportButton).toHaveText('Export 4 shown');
    let download = options.waitForEvent('download');
    await exportButton.click();
    const report = await readFile(await (await download).path(), 'utf8');
    expect(report).toContain('Body of a1');
    expect(report).not.toContain('Body of a5');
    await options.getByRole('combobox', { name: 'Export format' }).selectOption('json-lite');
    await expect(exportButton).toHaveText('Export all');
    download = options.waitForEvent('download');
    await exportButton.click();
    const bundle = JSON.parse(await readFile(await (await download).path(), 'utf8')) as ExportBundle;
    expect(bundle.notes.map((n) => n.id).toSorted()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);

    // Bulk: every shown note to Low, then to Completed. The archived one isn't shown, so it's untouched.
    await cards.first().getByRole('checkbox').check();
    const bulk = options.getByRole('toolbar', { name: 'Bulk actions' });
    await bulk.getByRole('button', { name: 'Select all 4' }).click();
    await expect(bulk).toContainText('4 selected');
    await bulk.getByRole('button', { name: 'Set priority' }).click();
    await expect(bulk.getByRole('menuitem')).toHaveText(['High', 'Medium', 'Low']);
    await bulk.getByRole('menuitem', { name: 'Low' }).click();
    await expect(options.getByText('4 notes set to Low priority')).toBeVisible();
    await bulk.getByRole('button', { name: 'Set status' }).click();
    await expect(bulk.getByRole('menuitem')).toHaveText(['Open', 'In progress', 'Completed', 'Archived']);
    await bulk.getByRole('menuitem', { name: 'Completed' }).click();
    await expect(options.getByText('4 notes set to Completed')).toBeVisible();

    const stored = async () => (await ext.notes(url)).map((n) => [n.id, n.status, n.priority]);
    await expect.poll(stored).toEqual([
      ['a1', 'completed', 'low'],
      ['a2', 'completed', 'low'],
      ['a3', 'completed', 'low'],
      ['a4', 'completed', 'low'],
      ['a5', 'archived', 'high'],
    ]);
    await expect(summary.getByRole('listitem')).toHaveText(['0 open', '0 in progress', '4 completed', '1 archived', '0 high priority']);
    for (const noteId of ['a1', 'a2', 'a3', 'a4']) {
      const card = options.locator(`article[data-note-id="${noteId}"]`);
      await expect(card.getByRole('button', { name: 'Status: Completed' })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Priority: Low' })).toBeVisible();
    }
  });

  test('a note saved before four statuses existed shows as Completed, Medium priority everywhere', async ({
    page,
    ext,
    server,
  }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);
    const note = await wm.createNote(d.cardValue('Churn'), 'Churn should be monthly', { up: 1 });
    const open = await wm.createNote(d.cardValue('Orders'), 'Orders need a total', { up: 1 });

    // Rewrite the first as the previous version stored it: 'resolved', no priority, schema 1.
    const key = `wm:notes:${note.pageKey}`;
    await (await ext.worker()).evaluate(
      async ({ key, id }) => {
        const notes = (await chrome.storage.local.get(key))[key] as Record<string, unknown>[];
        const legacy = notes.map((n) => {
          if (n.id !== id) return n;
          const { priority: _priority, ...rest } = n;
          return { ...rest, status: 'resolved', schemaVersion: 1 };
        });
        await chrome.storage.local.set({ [key]: legacy });
      },
      { key, id: note.id },
    );
    const raw = ((await ext.storage(key))[key] as Record<string, unknown>[]).find((n) => n.id === note.id)!;
    expect(raw).toMatchObject({ status: 'resolved', schemaVersion: 1 });
    expect(raw).not.toHaveProperty('priority');

    // The page, after a reload.
    await wm.reload();
    await wm.expectPinOn(note.id, d.card('Churn'));
    await expect(wm.pin(note.id)).toHaveAttribute('data-status', 'completed');
    await expect(wm.pin(note.id)).toHaveAttribute('data-priority', 'medium');
    await wm.pin(note.id).hover();
    await expect(page.locator(`[data-wm-tooltip="${note.id}"]`)).toContainText('Completed');
    await expect(page.locator(`[data-wm-tooltip="${note.id}"]`)).toContainText('Medium priority');
    await page.mouse.move(0, 0);
    await expect.poll(() => ext.badgeText(page)).toBe('1');
    expect((await ext.pageState(page)).statusCounts).toEqual({ open: 1, in_progress: 0, completed: 1, archived: 0 });

    // The page's editor.
    await wm.pin(note.id).click();
    const editor = wm.editor('edit');
    await expect(editor.locator('[data-wm-status]')).toHaveAttribute('data-wm-status', 'completed');
    await expect(editor.locator('[data-wm-priority]')).toHaveAttribute('data-wm-priority', 'medium');
    await page.keyboard.press('Escape');
    await expect(editor).toBeHidden();

    // The popup.
    const popup = await openExtensionPage(page, ext, 'popup.html');
    await page.bringToFront();
    const stats = popup.getByRole('definition');
    await expect(popup.getByRole('term')).toHaveText(['Open', 'In progress', 'Completed', 'Not found']);
    await expect(stats).toHaveText(['1', '0', '1', '0']);
    await expect(popup.locator(`.popup-note[data-status="completed"]`)).toContainText('Churn');
    await popup.close();

    // The side panel.
    const panel = await openExtensionPage(page, ext, 'sidepanel.html');
    await page.bringToFront();
    const card = panel.locator(`article[data-note-id="${note.id}"]`);
    await expect(card.getByRole('button', { name: 'Status: Completed' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Priority: Medium' })).toBeVisible();
    await panel.close();

    // The All notes page, and its exports.
    const options = await openExtensionPage(page, ext, 'options.html');
    const optionsCard = options.locator(`article[data-note-id="${note.id}"]`);
    await expect(optionsCard.getByRole('button', { name: 'Status: Completed' })).toBeVisible();
    await expect(optionsCard.getByRole('button', { name: 'Priority: Medium' })).toBeVisible();
    await options.getByRole('radiogroup', { name: 'Filter by status' }).getByRole('radio', { name: /Completed/ }).click();
    await expect(options.locator('article.wm-note-card')).toHaveCount(1);
    await options.getByRole('combobox', { name: 'Export format' }).selectOption('json-lite');
    const download = options.waitForEvent('download');
    await options.getByRole('button', { name: 'Export all' }).click();
    const bundle = JSON.parse(await readFile(await (await download).path(), 'utf8')) as ExportBundle;
    expect(bundle.notes.find((n) => n.id === note.id)).toMatchObject({ status: 'completed', priority: 'medium' });
    expect(bundle.notes.find((n) => n.id === open.id)).toMatchObject({ status: 'open', priority: 'medium' });

    // Its first change stores it in today's shape.
    await optionsCard.getByRole('button', { name: 'Reopen' }).click();
    await expect
      .poll(async () => ((await ext.storage(key))[key] as Record<string, unknown>[]).find((n) => n.id === note.id))
      .toMatchObject({ status: 'open', priority: 'medium', schemaVersion: NOTE_SCHEMA_VERSION });
  });
});
