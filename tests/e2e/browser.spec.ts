import { expect, STRICT_CSP, test } from './fixtures';
import { dashboard, inspectScreenshot, nearColor, openDashboard, rectOf, WebMark } from './webmark';

/*
 * Behaviour that only a real browser can show: device pixel ratio and
 * scrolling in screenshots, focus, the clipboard, and an extension update
 * while tabs are open.
 */

test.describe('real-browser behaviour', () => {
  test('screenshot on a zoomed page of an element that starts half off-screen', async ({ page, ext, server }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);
    await ext.setZoom(page, 1.5);
    await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(1.5);
    // A smooth-scrolling page must not leave the capture mid-scroll.
    await page.addStyleTag({ content: 'html { scroll-behavior: smooth; }' });

    // Scroll so the top half of the Churn card is above the viewport.
    const before = await rectOf(d.card('Churn'));
    await page.evaluate((top) => window.scrollBy({ top, behavior: 'instant' }), before.y + before.height / 2);
    expect((await rectOf(d.card('Churn'))).y).toBeLessThan(0);

    await wm.startPicker();
    await wm.pick(d.details('Churn'), { up: 1, expected: d.card('Churn') });
    await wm.write('Churn should be a percentage of paying users');
    expect(await wm.pageValue<number>('__clicks')).toBe(0);

    const [note] = await ext.notes(page);
    expect(note?.hasScreenshot).toBe(true);
    const shot = (await ext.storage(`wm:shot:${note!.id}`))[`wm:shot:${note!.id}`] as string;
    expect(shot).toMatch(/^data:image\/jpeg;base64,/);
    // The element was scrolled fully into view first (to the top edge, so the
    // padding above it is outside the viewport), so the whole card is in the shot.
    const card = await rectOf(d.card('Churn'));
    // (At 150% zoom scroll offsets snap to device pixels: 1/3 CSS px either way.)
    expect(card.y).toBeGreaterThan(-1);
    expect(card.y).toBeLessThan(1);
    const image = await inspectScreenshot(page, shot, card);
    expect(Math.abs(image.width - image.expectedWidth)).toBeLessThanOrEqual(2);
    expect(Math.abs(image.height - image.expectedHeight)).toBeLessThanOrEqual(2);
    expect(image.expectedHeight).toBeGreaterThan(card.height + 7);
    expect(nearColor(image.outside, [244, 245, 249]), `page background, got ${image.outside}`).toBe(true);
    expect(nearColor(image.inside, [255, 255, 255]), `card background, got ${image.inside}`).toBe(true);
    // Pins line up with the zoomed layout too.
    await wm.expectPinOn(note!.id, d.card('Churn'));
  });

  test('focus returns to the page field that had it once the editor closes', async ({ page, ext, server }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);
    const search = page.getByPlaceholder('Search orders');
    await search.click();
    await page.keyboard.type('ORD-10');

    await wm.startPicker();
    await wm.pick(d.cardValue('Revenue'), { up: 1 });
    await expect.poll(() => wm.focusedField()).toBe('data-wm-body');
    await wm.write('Revenue: which currency?');
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('ORD-10');

    // Same after cancelling a new note with Escape.
    await wm.startPicker();
    await wm.pick(d.cardValue('Users'), { up: 1 });
    await expect.poll(() => wm.focusedField()).toBe('data-wm-body');
    await page.keyboard.press('Escape');
    await expect(wm.editor()).toBeHidden();
    await expect(search).toBeFocused();
  });

  test('"Copy as Markdown" in the editor puts the note on the clipboard', async ({ context, page, ext, server }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin });
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);
    const note = await wm.createNote(d.cardValue('Orders'), 'Orders exclude cancelled ones', { up: 1, tags: 'data' });

    await wm.pin(note.id).click();
    const editor = wm.editor('edit');
    await editor.locator('[data-wm-copy]').click();
    await expect(page.locator('[data-wm-toast]').last()).toHaveText('Copied to clipboard');
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('Orders exclude cancelled ones');
    expect(clipboard).toContain(note.label);
    expect(clipboard).toContain(server.url('/dashboard.html'));
  });

  test('works on a page with a strict Content-Security-Policy', async ({ page, ext, server, errorLog }) => {
    // Init scripts run regardless of the page's CSP: record every violation the page reports.
    await page.addInitScript(() => {
      const violations: string[] = [];
      (window as unknown as { __violations: string[] }).__violations = violations;
      document.addEventListener('securitypolicyviolation', (e) => violations.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    const cspConsole: string[] = [];
    page.on('console', (m) => {
      if (/Content Security Policy/i.test(m.text())) cspConsole.push(m.text());
    });

    const wm = new WebMark(page, ext);
    const response = await page.goto(server.url('/strict-admin.html'));
    expect(response?.headers()['content-security-policy']).toBe(STRICT_CSP);
    await ext.waitForContentScript(page);
    const billing = page.getByRole('region', { name: 'Billing' });

    await wm.startPicker();
    await wm.hover(billing.locator('.amount'));
    await wm.expectHighlighted(billing.locator('.amount'));
    // The picker's own styles apply (a styled 2px highlight box, not a bare div).
    expect(await wm.pickerBox.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('2px');
    await page.keyboard.press('ArrowUp');
    await wm.expectHighlighted(billing);
    await page.keyboard.press('Enter');

    const editor = wm.editor('create');
    await expect(editor).toBeVisible();
    expect(await editor.evaluate((el) => getComputedStyle(el).width)).toBe('340px');
    // The screenshot preview (a data: URL) renders despite img-src 'self'.
    const thumb = editor.locator('[data-wm-shot]');
    await expect(thumb).toBeVisible();
    await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
    await wm.write('Show when the payment is due');

    const [note] = await ext.notes(page);
    expect(note?.hasScreenshot).toBe(true);
    await wm.expectPinOn(note!.id, billing);
    const pin = await wm.pin(note!.id).evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.width, s.height, s.borderTopLeftRadius];
    });
    expect(pin).toEqual(['24px', '24px', '50%']);

    expect(await wm.pageValue<string[]>('__violations')).toEqual([]);
    expect(cspConsole).toEqual([]);

    // Sanity check that the policy is really enforced: the page's own inline style is refused.
    const logged = errorLog.errors.length;
    const color = await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = 'body { color: rgb(255, 0, 0) !important; }';
      document.head.append(style);
      return getComputedStyle(document.body).color;
    });
    expect(color).not.toBe('rgb(255, 0, 0)');
    await expect.poll(() => wm.pageValue<string[]>('__violations')).toEqual([expect.stringMatching(/^style-src/)]);
    await expect.poll(() => cspConsole.length).toBe(1);
    // That refusal was this test's own doing, not WebMark's.
    const own = errorLog.errors.slice(logged).filter((e) => e.includes('Applying inline style violates'));
    expect(own).toHaveLength(1);
    errorLog.errors.splice(errorLog.errors.indexOf(own[0]!), 1);
  });

  test('picks the host of a web component, and an iframe as a whole', async ({ page, ext, server }) => {
    const wm = new WebMark(page, ext);
    await wm.open(server.url('/widgets.html'));

    // Inside a page's shadow root: the host element is what gets picked.
    const rating = page.locator('acme-rating');
    await wm.startPicker();
    const star = await wm.hover(rating.locator('.stars'));
    await wm.expectHighlighted(rating);
    await expect(wm.pickerLabel).toHaveText('acme-rating#rating');
    await wm.confirmPick(star);
    await wm.write('Show how many reviews this is based on');
    const [ratingNote] = await ext.notes(page);
    expect(ratingNote?.anchor).toMatchObject({ tagName: 'acme-rating', id: 'rating' });
    await wm.expectPinOn(ratingNote!.id, rating);

    // Over an iframe: the frame is picked and the page inside it never gets the click.
    const frame = page.locator('iframe#reviews');
    const helpful = page.frameLocator('#reviews').getByRole('button', { name: 'Helpful' });
    await wm.startPicker();
    const inside = await wm.hover(helpful);
    await wm.expectHighlighted(frame);
    await expect(wm.pickerLabel).toHaveText('iframe#reviews');
    await wm.confirmPick(inside);
    await wm.write('Reviews need paging');
    expect(await wm.pageValue<number>('__frameClicks')).toBe(0);
    const frameNote = (await ext.notes(page)).find((n) => n.id !== ratingNote!.id);
    expect(frameNote?.anchor).toMatchObject({ tagName: 'iframe', id: 'reviews' });
    await wm.expectPinOn(frameNote!.id, frame);

    // Once picking is over the frame is interactive again.
    await wm.waitForClickGuard();
    await helpful.click();
    expect(await wm.pageValue<number>('__frameClicks')).toBe(1);

    await wm.reload();
    await expect
      .poll(async () => (await ext.pageState(page)).resolvedIds.toSorted())
      .toEqual([ratingNote!.id, frameNote!.id].toSorted());
  });

  test('an extension update keeps open tabs working without a reload', async ({ page, ext, server }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);
    const note = await wm.createNote(d.cardValue('Sessions'), 'Sessions spike on Mondays', { up: 1 });
    await wm.expectPinOn(note.id, d.card('Sessions'));

    await ext.reloadExtension();
    // The old content script is orphaned; the background injects a fresh one into the open tab.
    await expect
      .poll(async () => (await ext.pageState(page).catch(() => undefined))?.resolvedIds, { timeout: 15_000 })
      .toEqual([note.id]);
    await expect(wm.host).toHaveCount(1);
    await wm.expectPinOn(note.id, d.card('Sessions'));
    await expect(wm.pins).toHaveCount(1);

    // The new instance does everything the old one did.
    const second = await wm.createNote(d.cardValue('Churn'), 'Churn after the update', { up: 1 });
    await wm.expectPinOn(second.id, d.card('Churn'));
    await wm.pin(note.id).click();
    await expect(wm.editor('edit')).toHaveAttribute('data-wm-note-id', note.id);
    await page.keyboard.press('Escape');
    await expect.poll(() => ext.badgeText(page)).toBe('2');
    // Clicks reach the page again once the picker is done.
    await wm.waitForClickGuard();
    await d.details('Revenue').click();
    expect(await wm.pageValue<number>('__clicks')).toBe(1);
  });
});
