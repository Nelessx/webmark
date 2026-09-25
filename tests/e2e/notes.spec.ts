import { getPageKey } from '../../src/lib/url';
import { expect, test } from './fixtures';
import { dashboard, inspectScreenshot, nearColor, openDashboard, rectDistance, rectOf, WebMark } from './webmark';

test.describe('in-page notes', () => {
  test('content script loads and its idle UI never blocks the page', async ({ page, ext, server }) => {
    const wm = new WebMark(page, ext);
    const url = server.url('/dashboard.html');
    await page.goto(url);
    const state = await ext.waitForContentScript(page);
    expect(state).toMatchObject({
      pageKey: getPageKey(url),
      pickerActive: false,
      pinsVisible: true,
      resolvedIds: [],
      orphanedIds: [],
      openCount: 0,
    });

    // One host element; its shadow root is open only in this E2E build.
    await expect(wm.host).toHaveCount(1);
    expect(await page.evaluate(() => document.querySelector('webmark-ui')?.shadowRoot?.mode)).toBe('open');

    // The full-viewport host must be click-through: the page gets the click.
    const d = dashboard(page);
    const details = d.details('Revenue');
    const box = await rectOf(details);
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.textContent,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(hit).toBe('Details');
    await details.click();
    await d.details('Churn').click();
    expect(await wm.pageValue<number>('__clicks')).toBe(2);
    expect(await wm.pageValue<string[]>('__clickLog')).toEqual(['Revenue', 'Churn']);

    // Typing into the page's own form still reaches the page.
    await page.getByPlaceholder('Search orders').fill('refund');
    await page.getByPlaceholder('Search orders').press('Enter');
    expect(await wm.pageValue<number>('__submits')).toBe(1);
  });

  test('picker: hover, ArrowUp to the card, click, write, Ctrl+Enter saves the note', async ({ page, ext, server }) => {
    const wm = new WebMark(page, ext);
    const url = server.url('/dashboard.html');
    await openDashboard(wm, url);
    const d = dashboard(page);

    // A click during picking picks; the page's own click handler must not run.
    await wm.startPicker();
    expect((await ext.pageState(page)).pickerActive).toBe(true);
    await wm.pick(d.details('Revenue'));
    await expect(wm.editor('create')).toBeVisible();
    await expect(wm.editor().locator('[data-wm-label]')).toHaveValue(/Details/);
    expect(await wm.pageValue<number>('__clicks')).toBe(0);
    await page.keyboard.press('Escape');
    await expect(wm.editor()).toBeHidden();
    expect(await ext.notes(page)).toEqual([]);

    // Hover the number, climb to the card with ArrowUp, click.
    await wm.startPicker();
    await wm.hover(d.cardValue('Revenue'));
    await wm.expectHighlighted(d.cardValue('Revenue'));
    await expect(wm.pickerLabel).toHaveText('p.card-value');
    await page.keyboard.press('ArrowUp');
    await wm.expectHighlighted(d.card('Revenue'));
    await expect(wm.pickerLabel).toHaveText('div.card');
    // ArrowDown goes back to where we climbed from, ArrowUp again to the card.
    await page.keyboard.press('ArrowDown');
    await wm.expectHighlighted(d.cardValue('Revenue'));
    await page.keyboard.press('ArrowUp');
    await wm.expectHighlighted(d.card('Revenue'));
    const value = await rectOf(d.cardValue('Revenue'));
    await wm.confirmPick({ x: value.x + value.width / 2, y: value.y + value.height / 2 });

    const editor = wm.editor('create');
    await expect(editor).toBeVisible();
    await expect(editor.locator('[data-wm-label]')).toHaveValue(/Revenue/);
    await wm.write('Revenue should include refunds');

    await expect.poll(async () => (await ext.notes(page)).length).toBe(1);
    const [note] = await ext.notes(page);
    expect(note).toMatchObject({
      pageKey: getPageKey(url),
      url,
      pageTitle: 'Acme Analytics · Dashboard',
      body: 'Revenue should include refunds',
      status: 'open',
      tags: [],
    });
    expect(note?.label).toContain('Revenue');
    expect(note?.anchor.tagName).toBe('div');
    expect(note?.anchor.classes).toEqual(['card']);
    expect(await ext.storage('wm:pages')).toEqual({ 'wm:pages': [getPageKey(url)] });
    expect(await wm.pageValue<number>('__clicks')).toBe(0);
    expect((await ext.pageState(page)).pickerActive).toBe(false);
  });

  test('pins: numbered pin on the element, survives reload, opens the editor, edits and resolves', async ({
    page,
    ext,
    server,
  }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);
    const note = await wm.createNote(d.cardValue('Revenue'), 'Check the currency', {
      up: 1,
      expected: d.card('Revenue'),
    });

    await expect(wm.pin(note.id)).toHaveText('1');
    await expect(wm.pin(note.id)).toHaveAttribute('data-status', 'open');
    await wm.expectPinOn(note.id, d.card('Revenue'));

    await wm.reload();
    expect((await ext.pageState(page)).resolvedIds).toEqual([note.id]);
    await expect(wm.pins).toHaveCount(1);
    await wm.expectPinOn(note.id, d.card('Revenue'));

    // Hover: tooltip with the note.
    await wm.pin(note.id).hover();
    await expect(page.locator(`[data-wm-tooltip="${note.id}"]`)).toContainText('Check the currency');

    // Click: the editor opens on the note, outlining its element.
    await wm.pin(note.id).click();
    const editor = wm.editor('edit');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-wm-note-id', note.id);
    await expect(editor.locator('[data-wm-body]')).toHaveValue('Check the currency');
    await expect.poll(async () => rectDistance(await page.locator('[data-wm-outline="target"]').boundingBox(), await d.card('Revenue').boundingBox())).toBeLessThanOrEqual(3.5);

    // Edit and save with Ctrl+Enter.
    await expect.poll(() => wm.focusedField()).toBe('data-wm-body');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Show the currency next to the value');
    await page.keyboard.press('Control+Enter');
    await expect(editor).toBeHidden();
    await expect.poll(async () => (await ext.note(page, note.id))?.body).toBe('Show the currency next to the value');

    // Resolve from the editor.
    await wm.pin(note.id).click();
    await expect(editor.locator('[data-wm-body]')).toHaveValue('Show the currency next to the value');
    await editor.locator('[data-wm-status-option="resolved"]').click();
    await editor.locator('[data-wm-save]').click();
    await expect(editor).toBeHidden();
    await expect.poll(async () => (await ext.note(page, note.id))?.status).toBe('resolved');
    await expect(wm.pin(note.id)).toHaveAttribute('data-status', 'resolved');
    expect((await ext.pageState(page)).openCount).toBe(0);

    // Reopen and delete from the editor.
    await wm.pin(note.id).click();
    await editor.locator('[data-wm-delete]').click();
    await editor.locator('[data-wm-delete-confirm]').click();
    await expect(editor).toBeHidden();
    await expect(wm.pins).toHaveCount(0);
    await expect.poll(async () => (await ext.notes(page)).length).toBe(0);
    expect((await ext.storage('wm:pages'))['wm:pages']).toEqual([]);
  });

  test('saves a cropped JPEG screenshot of the element with the note', async ({ page, ext, server }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);

    await wm.startPicker();
    await wm.pick(d.cardValue('Users'), { up: 1, expected: d.card('Users') });
    // The editor previews the screenshot before saving.
    await expect(wm.editor('create').locator('[data-wm-shot]')).toBeVisible();
    await wm.write('Users should mean monthly actives');

    const [note] = await ext.notes(page);
    expect(note?.hasScreenshot).toBe(true);
    const shot = await ext.screenshot(note!.id);
    expect(typeof shot).toBe('string');
    expect(shot as string).toMatch(/^data:image\/jpeg;base64,/);

    // It is the card plus 8px padding, cut from the page without WebMark's own
    // UI in it (the picker's tinted highlight would change the card's white).
    const card = await rectOf(d.card('Users'));
    const image = await inspectScreenshot(page, shot as string, card);
    expect(image.expectedWidth).toBeCloseTo(card.width + 16, 0);
    expect(image.expectedHeight).toBeCloseTo(card.height + 16, 0);
    expect(Math.abs(image.width - image.expectedWidth)).toBeLessThanOrEqual(2);
    expect(Math.abs(image.height - image.expectedHeight)).toBeLessThanOrEqual(2);
    expect(nearColor(image.outside, [244, 245, 249]), `page background, got ${image.outside}`).toBe(true);
    expect(nearColor(image.inside, [255, 255, 255]), `card background, got ${image.inside}`).toBe(true);
  });

  test('context menu: the right-clicked element gets the editor', async ({ page, ext, server }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);
    const target = d.rowCustomer(7);

    await target.scrollIntoViewIfNeeded();
    await target.click({ button: 'right' });
    // What the background does for "Add WebMark note to this element".
    expect(await ext.send(page, { type: 'wm:note-from-context-menu' })).toEqual({ ok: true });
    const editor = wm.editor('create');
    await expect(editor).toBeVisible();
    await expect(editor.locator('[data-wm-label]')).toHaveValue(/Customer 7/);
    await wm.write('Link the customer to their profile');

    const [note] = await ext.notes(page);
    expect(note?.anchor).toMatchObject({ tagName: 'span', text: 'Customer 7' });
    await wm.expectPinOn(note!.id, target);

    // Without a right-click first, the menu item falls back to the picker.
    expect(await ext.send(page, { type: 'wm:note-from-context-menu' })).toEqual({ ok: true });
    await expect(wm.pickerHint).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(wm.pickerHint).toBeHidden();
    expect((await ext.pageState(page)).pickerActive).toBe(false);
  });

  test('keys pressed while picking and typing a note never reach the page', async ({ page, ext, server }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);

    // Sanity: the page does count its own keydowns.
    await page.keyboard.press('KeyG');
    expect(await wm.pageValue<number>('__pageKeys')).toBe(1);

    await wm.startPicker();
    await wm.hover(d.cardValue('Orders'));
    await wm.expectHighlighted(d.cardValue('Orders'));
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await wm.expectHighlighted(d.card('Orders'));
    await page.keyboard.press('Enter');

    const editor = wm.editor('create');
    await expect(editor).toBeVisible();
    await expect.poll(() => wm.focusedField()).toBe('data-wm-body');
    await page.keyboard.type('Orders: show week over week. j/k ? / s g-i must stay in WebMark!');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Second line');
    await page.keyboard.press('Tab');
    expect(await wm.focusedField()).toBe('data-wm-tags');
    await page.keyboard.type('ux, data');
    await page.keyboard.press('Control+Enter');
    await expect(editor).toBeHidden();

    const [note] = await ext.notes(page);
    expect(note?.body).toBe('Orders: show week over week. j/k ? / s g-i must stay in WebMark\nSecond line');
    expect(note?.tags).toEqual(['ux', 'data']);
    expect(await wm.pageValue<number>('__pageKeys')).toBe(1);
  });

  test('editor: a draft asks before being discarded; an untouched editor closes on a page click', async ({
    page,
    ext,
    server,
  }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);

    await wm.startPicker();
    await wm.pick(d.cardValue('Refunds'), { up: 1 });
    const editor = wm.editor('create');
    await expect.poll(() => wm.focusedField()).toBe('data-wm-body');
    await page.keyboard.type('Half-written thought');
    // Escape on a draft: confirm first.
    await page.keyboard.press('Escape');
    await expect(editor.locator('[data-wm-confirm="discard"]')).toBeVisible();
    await editor.getByRole('button', { name: 'Keep editing' }).click();
    await expect(editor.locator('[data-wm-body]')).toHaveValue('Half-written thought');
    // A page click leaves a draft alone.
    await wm.waitForClickGuard();
    await d.card('Users').click({ position: { x: 5, y: 5 } });
    await expect(editor).toBeVisible();
    await expect(editor.locator('[data-wm-body]')).toHaveValue('Half-written thought');
    // Back in the draft, Escape then Discard.
    await editor.locator('[data-wm-body]').click();
    await page.keyboard.press('Escape');
    await editor.locator('[data-wm-discard]').click();
    await expect(editor).toBeHidden();
    expect(await ext.notes(page)).toEqual([]);

    // An untouched editor just closes when the page is clicked.
    await wm.startPicker();
    await wm.pick(d.cardValue('Refunds'), { up: 1 });
    await expect(editor).toBeVisible();
    await wm.waitForClickGuard();
    await d.card('Users').click({ position: { x: 5, y: 5 } });
    await expect(editor).toBeHidden();
    expect(await ext.notes(page)).toEqual([]);
  });

  test('pins can be hidden and shown, and the choice sticks', async ({ context, page, ext, server }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);
    const note = await wm.createNote(d.cardValue('Sessions'), 'Sessions include bots', { up: 1 });
    await wm.expectPinOn(note.id, d.card('Sessions'));

    // Alt+Shift+P and the context menu item toggle.
    expect(await ext.send(page, { type: 'wm:set-pins-visible' })).toEqual({ ok: true });
    await expect(wm.pins).toHaveCount(0);
    await expect(page.locator('[data-wm-toast]').last()).toHaveText('Pins hidden');
    expect((await ext.pageState(page)).pinsVisible).toBe(false);
    await expect.poll(async () => (await ext.settings()).pinsVisible).toBe(false);

    // Remembered across page loads (the note is still found, just not drawn).
    await wm.reload();
    expect((await ext.pageState(page)).resolvedIds).toEqual([note.id]);
    await expect(wm.pins).toHaveCount(0);
    expect(await ext.send(page, { type: 'wm:set-pins-visible', visible: true })).toEqual({ ok: true });
    await wm.expectPinOn(note.id, d.card('Sessions'));

    // The dashboard's switch applies to open pages right away.
    const options = await context.newPage();
    await options.goto(ext.url('options.html#settings'));
    const pinsSwitch = options.locator('label.wm-switch', { hasText: 'Show note pins' }).getByRole('switch');
    await pinsSwitch.click();
    await expect(pinsSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(wm.pins).toHaveCount(0);
    await pinsSwitch.click();
    await expect(wm.pin(note.id)).toBeVisible();
  });

  test('several notes on one element sit in a numbered row, stamped with the author name', async ({
    context,
    page,
    ext,
    server,
  }) => {
    const options = await context.newPage();
    await options.goto(ext.url('options.html#settings'));
    const name = options.getByRole('textbox', { name: 'Your name' });
    await name.fill('Dana');
    await name.press('Enter');
    await expect.poll(async () => (await ext.settings()).authorName).toBe('Dana');
    await options.close();

    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);
    await wm.startPicker();
    await wm.pick(d.cardValue('Revenue'), { up: 1 });
    await expect(wm.editor('create')).toContainText('Posting as Dana');
    await wm.write('First remark');
    const second = await wm.createNote(d.cardValue('Revenue'), 'Second remark', { up: 1 });
    const [first] = await ext.notes(page);
    expect(first?.author).toBe('Dana');
    expect(second.author).toBe('Dana');

    // The newest pin sits on the corner, earlier ones to its left.
    await wm.expectPinOn(second.id, d.card('Revenue'));
    await expect(wm.pin(first!.id)).toHaveText('1');
    await expect(wm.pin(second.id)).toHaveText('2');
    const [a, b] = [await rectOf(wm.pin(first!.id)), await rectOf(wm.pin(second.id))];
    expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.x - a.x - 28)).toBeLessThanOrEqual(1);
  });

  test('survives the page swapping its whole <body> (Turbo, pjax)', async ({ page, ext, server }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);
    const note = await wm.createNote(d.cardValue('Refunds'), 'Refunds are delayed', { up: 1 });
    await wm.expectPinOn(note.id, d.card('Refunds'));

    const oldCard = await d.card('Refunds').elementHandle();
    await page.evaluate(() => (window as unknown as { __swapBody(): void }).__swapBody());
    expect(await oldCard?.evaluate((el) => el.isConnected)).toBe(false);
    // Our UI is put back into the new <body>, and the pin finds the new card.
    await expect.poll(() => page.evaluate(() => document.querySelectorAll('body > webmark-ui').length)).toBe(1);
    await wm.expectPinOn(note.id, d.card('Refunds'));

    // Everything keeps working on the new body.
    const second = await wm.createNote(d.cardValue('Churn'), 'Churn is monthly?', { up: 1 });
    await wm.expectPinOn(second.id, d.card('Churn'));
    await wm.expectPinOn(note.id, d.card('Refunds'));
  });

  test('two tabs of the same page stay in sync', async ({ context, page, ext, server }) => {
    // Tracking parameters don't change the page key, but keep the two tabs' URLs apart.
    const urlA = server.url('/dashboard.html?utm_source=tab-a');
    const urlB = server.url('/dashboard.html?utm_source=tab-b');
    const a = new WebMark(page, ext);
    await openDashboard(a, urlA);
    const other = await context.newPage();
    const b = new WebMark(other, ext);
    await b.open(urlB);
    expect((await ext.pageState(other)).pageKey).toBe((await ext.pageState(page)).pageKey);

    // A note written in tab A shows up in tab B right away.
    await page.bringToFront();
    const note = await a.createNote(dashboard(page).cardValue('Revenue'), 'Seen in both tabs', { up: 1 });
    await b.expectPinOn(note.id, dashboard(other).card('Revenue'));
    await expect.poll(() => ext.badgeText(other)).toBe('1');
    await expect.poll(() => ext.badgeText(page)).toBe('1');

    // Tab B has the note open when tab A deletes it.
    await other.bringToFront();
    await b.pin(note.id).click();
    await expect(b.editor('edit')).toBeVisible();
    await page.bringToFront();
    await a.pin(note.id).click();
    await a.editor('edit').locator('[data-wm-delete]').click();
    await a.editor('edit').locator('[data-wm-delete-confirm]').click();
    await expect(b.editor()).toBeHidden();
    await expect(other.locator('[data-wm-toast]').last()).toHaveText('This note was deleted');
    await expect(b.pins).toHaveCount(0);
    await expect.poll(() => ext.badgeText(other)).toBe('');
  });

  test('toolbar badge shows the number of open notes on the tab', async ({ page, ext, server }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);
    await expect.poll(() => ext.badgeText(page)).toBe('');

    const first = await wm.createNote(d.cardValue('Revenue'), 'First', { up: 1 });
    await expect.poll(() => ext.badgeText(page)).toBe('1');
    await wm.createNote(d.cardValue('Churn'), 'Second', { up: 1 });
    await expect.poll(() => ext.badgeText(page)).toBe('2');

    // A reloaded page reports again.
    await wm.reload();
    await expect.poll(() => ext.badgeText(page)).toBe('2');

    // Resolving a note counts down.
    await wm.pin(first.id).click();
    await wm.editor('edit').locator('[data-wm-status-option="resolved"]').click();
    await page.keyboard.press('Control+Enter');
    await expect.poll(() => ext.badgeText(page)).toBe('1');
  });
});
