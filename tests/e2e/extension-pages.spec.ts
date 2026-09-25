import { readFile } from 'node:fs/promises';
import type { ExportBundle } from '../../src/lib/export';
import { expect, test } from './fixtures';
import { dashboard, openDashboard, WebMark } from './webmark';

test.describe('extension pages', () => {
  test('popup, side panel and dashboard load without errors; install opens the welcome screen', async ({
    context,
    ext,
    installTabs,
  }) => {
    expect(installTabs).toEqual([ext.url('options.html#welcome')]);
    // Opened directly, the popup and side panel look at their own (extension) tab.
    for (const [name, text] of [
      ['popup.html', "WebMark can't run on this page"],
      ['sidepanel.html', "WebMark can't run on this page"],
      ['options.html', 'No notes yet'],
    ] as const) {
      const page = await context.newPage();
      await page.goto(ext.url(name));
      await expect(page.getByText('WebMark', { exact: true }).first()).toBeVisible();
      await expect(page.getByText(text)).toBeVisible();
      await page.close();
    }
  });

  test('popup and side panel act on the active tab', async ({ context, page, ext, server }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);
    const note = await wm.createNote(d.cardValue('Revenue'), 'Revenue needs a tooltip', { up: 1 });

    // The side panel, like the real one, follows the active tab of its window.
    const panel = await context.newPage();
    await panel.goto(ext.url('sidepanel.html'));
    await page.bringToFront();
    await expect(panel.getByRole('heading', { level: 1 })).toHaveText('Acme Analytics · Dashboard');
    const card = panel.locator(`article[data-note-id="${note.id}"]`);
    await expect(card).toContainText('Revenue needs a tooltip');
    // "Show on page" scrolls to the element, flashes it and opens the note.
    await card.getByRole('button', { name: 'Show on page', exact: true }).click();
    await expect(wm.editor('edit')).toHaveAttribute('data-wm-note-id', note.id);
    await expect(page.locator('[data-wm-outline="flash"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(wm.editor()).toBeHidden();

    // The popup's "Add note" starts the picker in the page, then closes the popup.
    const popup = await context.newPage();
    await popup.goto(ext.url('popup.html'));
    await page.bringToFront();
    await expect(popup.getByText('Revenue needs a tooltip')).toBeVisible();
    const closed = popup.waitForEvent('close');
    await popup.getByRole('button', { name: /Add note/ }).click();
    await closed;
    await expect(wm.pickerHint).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(wm.pickerHint).toBeHidden();
  });

  test('All notes: list, search, status filter, bulk status, JSON export, settings, welcome', async ({
    context,
    page,
    ext,
    server,
  }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);
    const revenue = await wm.createNote(d.cardValue('Revenue'), 'Revenue excludes refunds', { up: 1, tags: 'bug, data' });
    const users = await wm.createNote(d.cardValue('Users'), 'Rename to Active users', { up: 1, tags: 'copy' });
    const row = await wm.createNote(d.rowCustomer(7), 'Customer name is cut off');

    const options = await context.newPage();
    await options.goto(ext.url('options.html'));
    const cards = options.locator('article.wm-note-card');
    const cardFor = (id: string) => options.locator(`article[data-note-id="${id}"]`);
    const summary = options.getByRole('list', { name: 'Summary' });
    await expect(cards).toHaveCount(3);
    await expect(options.getByText('3 notes on 1 page')).toBeVisible();
    await expect(summary.getByRole('listitem')).toHaveText([
      '3 open',
      '0 in progress',
      '0 completed',
      '0 archived',
      '0 high priority',
    ]);
    await expect(options.getByRole('heading', { level: 2, name: 'Acme Analytics · Dashboard' })).toBeVisible();
    await expect(cardFor(revenue.id)).toContainText('Revenue excludes refunds');
    await expect(cardFor(revenue.id).getByRole('button', { name: /Enlarge screenshot/ }).locator('img')).toBeVisible();

    // Search.
    const search = options.getByRole('searchbox', { name: 'Search notes' });
    await search.fill('refunds');
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute('data-note-id', revenue.id);
    await search.fill('#copy');
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute('data-note-id', users.id);
    await search.fill('');
    await expect(cards).toHaveCount(3);

    // Complete one from its card's status menu, then filter by status.
    await cardFor(users.id).getByRole('button', { name: 'Status: Open' }).click();
    await options.getByRole('menuitemradio', { name: 'Completed' }).click();
    await expect.poll(async () => (await ext.note(page, users.id))?.status).toBe('completed');
    await expect(cardFor(users.id).getByRole('button', { name: 'Status: Completed' })).toBeVisible();
    const status = options.getByRole('radiogroup', { name: 'Filter by status' });
    await status.getByRole('radio', { name: /Completed/ }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute('data-note-id', users.id);
    await status.getByRole('radio', { name: /Open/ }).click();
    await expect(cards).toHaveCount(2);
    await status.getByRole('radio', { name: /All/ }).click();
    await expect(cards).toHaveCount(3);

    // Bulk-complete the two open notes.
    await cardFor(revenue.id).getByRole('checkbox').check();
    await cardFor(row.id).getByRole('checkbox').check();
    const bulk = options.getByRole('toolbar', { name: 'Bulk actions' });
    await expect(bulk).toContainText('2 selected');
    await bulk.getByRole('button', { name: 'Set status' }).click();
    await bulk.getByRole('menuitem', { name: 'Completed' }).click();
    await expect.poll(async () => (await ext.notes(page)).map((n) => n.status)).toEqual(['completed', 'completed', 'completed']);
    await expect(summary.getByRole('listitem').first()).toHaveText('0 open');
    await expect(summary.getByRole('listitem').nth(2)).toHaveText('3 completed');
    // The page's pins follow (pins are drawn for on-screen elements).
    await d.card('Revenue').scrollIntoViewIfNeeded();
    await expect(wm.pin(revenue.id)).toHaveAttribute('data-status', 'completed');

    // JSON backup export.
    await options.getByRole('combobox', { name: 'Export format' }).selectOption('json');
    const download = options.waitForEvent('download');
    await options.getByRole('button', { name: 'Export all' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^webmark-\d{4}-\d{2}-\d{2}\.json$/);
    const bundle = JSON.parse(await readFile(await file.path(), 'utf8')) as ExportBundle;
    expect(bundle.format).toBe('webmark');
    expect(bundle.notes.map((n) => n.id).toSorted()).toEqual([revenue.id, users.id, row.id].toSorted());
    expect(bundle.notes.find((n) => n.id === revenue.id)).toMatchObject({ body: 'Revenue excludes refunds', tags: ['bug', 'data'] });
    expect(bundle.screenshots[revenue.id]).toMatch(/^data:image\/jpeg;base64,/);

    // A settings switch persists.
    await options.getByRole('button', { name: 'Settings' }).click();
    const screenshots = options.locator('label.wm-switch', { hasText: 'Save a screenshot' }).getByRole('switch');
    await expect(screenshots).toHaveAttribute('aria-checked', 'true');
    await screenshots.click();
    await expect(screenshots).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => (await ext.settings()).captureScreenshots).toBe(false);
    await options.reload();
    await options.getByRole('button', { name: 'Settings' }).click();
    await expect(screenshots).toHaveAttribute('aria-checked', 'false');
    // ...and applies to new notes.
    await page.bringToFront();
    const plain = await wm.createNote(d.cardValue('Orders'), 'No screenshot please', { up: 1 });
    expect(plain.hasScreenshot).toBe(false);
    expect(await ext.screenshot(plain.id)).toBeUndefined();

    // The welcome screen.
    await options.goto(ext.url('options.html#welcome'));
    const welcome = options.getByRole('region', { name: 'Welcome' });
    await expect(welcome).toContainText('Welcome to WebMark');
    await welcome.getByRole('button', { name: 'Got it' }).click();
    await expect(welcome).toBeHidden();
    expect(options.url()).toBe(ext.url('options.html'));

    // A deep link highlights one note.
    await options.goto(ext.url(`options.html#note=${row.id}`));
    await expect(cardFor(row.id)).toHaveClass(/is-highlighted/);
  });

  test('saving the in-page editor keeps changes made in the dashboard meanwhile', async ({
    context,
    page,
    ext,
    server,
  }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);
    const note = await wm.createNote(d.cardValue('Revenue'), 'Original wording', { up: 1, tags: 'data' });

    // The note is open in the page's editor...
    await wm.pin(note.id).click();
    const editor = wm.editor('edit');
    await expect(editor).toBeVisible();

    // ...while it gets started and made high priority in the dashboard.
    const options = await context.newPage();
    await options.goto(ext.url('options.html'));
    const card = options.locator(`article[data-note-id="${note.id}"]`);
    await card.getByRole('button', { name: 'Start' }).click();
    await expect.poll(async () => (await ext.note(page, note.id))?.status).toBe('in_progress');
    await card.getByRole('button', { name: 'Priority: Medium' }).click();
    await options.getByRole('menuitemradio', { name: 'High' }).click();
    await expect.poll(async () => (await ext.note(page, note.id))?.priority).toBe('high');

    // Back in the page only the text is edited: the status and priority must survive the save.
    await page.bringToFront();
    await editor.locator('[data-wm-body]').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Better wording');
    await page.keyboard.press('Control+Enter');
    await expect(editor).toBeHidden();
    await expect.poll(async () => (await ext.note(page, note.id))?.body).toBe('Better wording');
    expect(await ext.note(page, note.id)).toMatchObject({
      status: 'in_progress',
      priority: 'high',
      tags: ['data'],
      label: note.label,
    });
  });

  test('saving the dashboard editor keeps changes made in the page meanwhile', async ({ context, page, ext, server }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);
    const note = await wm.createNote(d.cardValue('Users'), 'Count only active users', { up: 1, tags: 'data' });

    // The note is open in the dashboard's inline editor...
    const options = await context.newPage();
    await options.goto(ext.url('options.html'));
    const card = options.locator(`article[data-note-id="${note.id}"]`);
    await card.getByRole('button', { name: 'Edit note' }).click();
    const label = card.getByRole('textbox', { name: 'Element' });
    await expect(label).toHaveValue(note.label);

    // ...while the text and tags are changed on the page.
    await page.bringToFront();
    await wm.pin(note.id).click();
    const editor = wm.editor('edit');
    await editor.locator('[data-wm-body]').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Count only users active in the last 30 days');
    await editor.locator('[data-wm-tags]').fill('data, metrics');
    await page.keyboard.press('Control+Enter');
    await expect(editor).toBeHidden();
    await expect.poll(async () => (await ext.note(page, note.id))?.tags).toEqual(['data', 'metrics']);

    // Back in the dashboard only the label is edited: the page's changes must survive the save.
    await options.bringToFront();
    await label.fill('Users card');
    await card.getByRole('button', { name: 'Save' }).click();
    await expect.poll(async () => (await ext.note(page, note.id))?.label).toBe('Users card');
    expect(await ext.note(page, note.id)).toMatchObject({
      body: 'Count only users active in the last 30 days',
      tags: ['data', 'metrics'],
    });
  });

  test('All notes: "Open on page" reveals the note in its open tab, or opens the page first', async ({
    context,
    page,
    ext,
    server,
  }) => {
    const url = server.url('/dashboard.html');
    const wm = new WebMark(page, ext);
    await openDashboard(wm, url);
    const d = dashboard(page);
    const note = await wm.createNote(d.rowCustomer(18), 'Customer 18 is a duplicate', { up: 1, expected: d.row(18) });
    await page.evaluate(() => window.scrollTo(0, 0));

    const options = await context.newPage();
    await options.goto(ext.url('options.html'));
    const openOnPage = options.locator(`article[data-note-id="${note.id}"]`).getByRole('button', { name: 'Open on page', exact: true });

    // The page is open in a tab: switch to it, scroll to the element and open the note.
    await openOnPage.click();
    await expect(wm.editor('edit')).toHaveAttribute('data-wm-note-id', note.id);
    await expect(d.row(18)).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(wm.editor()).toBeHidden();

    // The page is not open: it opens in a new tab and the note is shown once it loads.
    await page.close();
    const newTab = context.waitForEvent('page');
    await options.bringToFront();
    await openOnPage.click();
    const opened = await newTab;
    await expect(opened).toHaveURL(url);
    const reopened = new WebMark(opened, ext);
    await expect(reopened.editor('edit')).toHaveAttribute('data-wm-note-id', note.id, { timeout: 15_000 });
    await expect(dashboard(opened).row(18)).toBeInViewport();
    expect(await ext.storage('wm:pending-focus')).toEqual({});
  });

  test('All notes: a JSON backup restores deleted notes and screenshots; tag filter', async ({
    context,
    page,
    ext,
    server,
  }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);
    const revenue = await wm.createNote(d.cardValue('Revenue'), 'Revenue excludes refunds', { up: 1, tags: 'bug, data' });
    const users = await wm.createNote(d.cardValue('Users'), 'Rename to Active users', { up: 1, tags: 'copy' });
    const original = await ext.notes(page);

    const options = await context.newPage();
    await options.goto(ext.url('options.html'));
    const cards = options.locator('article.wm-note-card');
    await expect(cards).toHaveCount(2);

    // Tag filter.
    const tags = options.getByRole('list', { name: 'Filter by tag' });
    await tags.getByRole('button', { name: /^copy/ }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute('data-note-id', users.id);
    await tags.getByRole('button', { name: /^copy/ }).click();
    await expect(cards).toHaveCount(2);

    // Back up, delete everything, restore.
    await options.getByRole('combobox', { name: 'Export format' }).selectOption('json');
    const download = options.waitForEvent('download');
    await options.getByRole('button', { name: 'Export all' }).click();
    const backup = await (await download).path();

    await cards.first().getByRole('checkbox').check();
    const bulk = options.getByRole('toolbar', { name: 'Bulk actions' });
    await bulk.getByRole('button', { name: 'Select all 2' }).click();
    await expect(bulk).toContainText('2 selected');
    await bulk.getByRole('button', { name: 'Delete 2' }).click();
    await bulk.getByRole('button', { name: 'Delete 2 notes?' }).click();
    await expect(options.getByText('No notes yet')).toBeVisible();
    await expect.poll(async () => (await ext.notes(page)).length).toBe(0);
    await expect(wm.pins).toHaveCount(0);
    expect(await ext.screenshot(revenue.id)).toBeUndefined();

    await options.locator('input[type="file"]').setInputFiles(backup);
    await expect(options.getByText('Imported: 2 added, 0 updated, 0 unchanged')).toBeVisible();
    await expect(cards).toHaveCount(2);
    expect(await ext.notes(page)).toEqual(original);
    expect(await ext.screenshot(revenue.id)).toMatch(/^data:image\/jpeg;base64,/);
    // The open page picks the restored notes up.
    await wm.expectPinOn(revenue.id, d.card('Revenue'));
    await wm.expectPinOn(users.id, d.card('Users'));

    // Importing the same file again changes nothing.
    await options.locator('input[type="file"]').setInputFiles(backup);
    await expect(options.getByText('Imported: 0 added, 0 updated, 2 unchanged')).toBeVisible();
  });
});
