import { getPageKey } from '../../src/lib/url';
import { expect, test } from './fixtures';
import { dashboard, openDashboard, WebMark } from './webmark';

test.describe('finding annotated elements again', () => {
  test('notes follow their elements through a redeploy and are orphaned when the element is gone', async ({
    context,
    page,
    ext,
    server,
  }) => {
    const wm = new WebMark(page, ext);
    const url = server.url('/dashboard.html');
    await openDashboard(wm, url);
    const d = dashboard(page);

    const revenue = await wm.createNote(d.cardValue('Revenue'), 'Revenue card', { up: 1, expected: d.card('Revenue') });
    const row = await wm.createNote(d.rowCustomer(7), 'Order row 7', { up: 1, expected: d.row(7) });
    expect(row.anchor.tagName).toBe('li');

    // Live data: the annotated card's value changed.
    await openDashboard(wm, url, 'live');
    await expect(d.cardValue('Revenue')).toHaveText('$12,810');
    await expect
      .poll(async () => (await ext.pageState(page)).resolvedIds.toSorted())
      .toEqual([revenue.id, row.id].toSorted());
    await wm.expectPinOn(revenue.id, d.card('Revenue'));

    // Redeploy: a card inserted first, every class name hashed, another card's text changed.
    await openDashboard(wm, url, 'shifted');
    await expect(d.cards.first()).toContainText('Profit');
    await expect(d.card('Revenue')).toHaveAttribute('class', /^css-/);
    await expect(d.cardValue('Users')).toHaveText('1,031');
    await expect
      .poll(async () => (await ext.pageState(page)).resolvedIds.toSorted())
      .toEqual([revenue.id, row.id].toSorted());
    // Pins are drawn for elements on screen, so check each where it is scrolled into view.
    await wm.expectPinOn(revenue.id, d.card('Revenue'));
    await expect(wm.pin(revenue.id)).toHaveText('1');
    await wm.expectPinOn(row.id, d.row(7));
    await expect(wm.pin(row.id)).toHaveText('2');

    // The Revenue card is removed: its note is orphaned and no other card takes its pin.
    await openDashboard(wm, url, 'removed');
    await expect(d.card('Revenue')).toHaveCount(0);
    await expect
      .poll(async () => {
        const state = await ext.pageState(page);
        return { resolved: state.resolvedIds, orphaned: state.orphanedIds };
      })
      .toEqual({ resolved: [row.id], orphaned: [revenue.id] });
    await wm.expectPinOn(row.id, d.row(7));
    await expect(wm.pins).toHaveCount(1);
    await expect(wm.pin(revenue.id)).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    for (const title of ['Users', 'Orders', 'Refunds', 'Sessions', 'Churn']) {
      const card = await d.card(title).boundingBox();
      const pins = await wm.pins.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect));
      for (const pin of pins) {
        const nearCorner =
          card && Math.abs(pin.x + pin.width / 2 - (card.x + card.width)) < 30 && Math.abs(pin.y + pin.height / 2 - card.y) < 30;
        expect(nearCorner, `a pin sits on the ${title} card`).toBeFalsy();
      }
    }

    // Revealing the orphan (popup / side panel "show on page") explains it's missing...
    expect(await ext.send(page, { type: 'wm:focus-note', noteId: revenue.id })).toEqual({ found: false });
    const orphanCard = page.locator(`[data-wm-orphan-card="${revenue.id}"]`);
    await expect(orphanCard).toContainText("isn't on the page");
    await expect(orphanCard).toContainText('Revenue card');
    // ...with a way to the note in the dashboard.
    const dashboardTab = context.waitForEvent('page');
    await orphanCard.getByRole('button', { name: 'Open in dashboard' }).click();
    const options = await dashboardTab;
    await expect(options).toHaveURL(ext.url(`options.html#note=${revenue.id}`));
    await expect(options.locator(`article[data-note-id="${revenue.id}"]`)).toHaveClass(/is-highlighted/);
    await options.close();
    await page.bringToFront();

    // The original page again: both notes are back where they were.
    await openDashboard(wm, url);
    await expect
      .poll(async () => (await ext.pageState(page)).resolvedIds.toSorted())
      .toEqual([revenue.id, row.id].toSorted());
    await wm.expectPinOn(revenue.id, d.card('Revenue'));
    await wm.expectPinOn(row.id, d.row(7));
  });

  test('SPA: notes belong to their route and come back on history navigation', async ({ page, ext, server }) => {
    const wm = new WebMark(page, ext);
    const projectsUrl = server.url('/spa.html');
    const teamUrl = server.url('/spa.html?view=team');
    await wm.open(projectsUrl);
    const item = (title: string) => page.getByRole('heading', { level: 3, name: title, exact: true }).locator('xpath=..');
    const brand = page.getByText('Northwind Workspace', { exact: true });

    const apollo = await wm.createNote(item('Apollo').locator('p'), 'Apollo needs a launch date', {
      up: 1,
      expected: item('Apollo'),
    });
    // The header stays mounted on every route, but this note belongs to the Projects route.
    const header = await wm.createNote(brand, 'Logo is blurry');
    await expect(wm.pins).toHaveCount(2);
    await expect.poll(() => ext.badgeText(page)).toBe('2');

    // Client-side navigation (history.pushState) to the Team route.
    await wm.waitForClickGuard();
    await page.getByRole('link', { name: 'Team' }).click();
    await expect(page).toHaveURL(teamUrl);
    await expect.poll(async () => (await ext.pageState(page)).pageKey).toBe(getPageKey(teamUrl));
    await expect(item('Dana Whitfield')).toBeVisible();
    await expect(brand).toBeVisible();
    await expect(wm.pins).toHaveCount(0);
    await expect.poll(() => ext.badgeText(page)).toBe('');

    const dana = await wm.createNote(item('Dana Whitfield').locator('p'), 'Add a photo', {
      up: 1,
      expected: item('Dana Whitfield'),
    });
    expect(dana.pageKey).toBe(getPageKey(teamUrl));
    await expect(wm.pins).toHaveCount(1);
    await expect(wm.pin(dana.id)).toHaveText('1');
    await expect.poll(() => ext.badgeText(page)).toBe('1');

    // Back to Projects.
    await page.goBack();
    await expect(page).toHaveURL(projectsUrl);
    await expect
      .poll(async () => (await ext.pageState(page)).resolvedIds.toSorted())
      .toEqual([apollo.id, header.id].toSorted());
    await expect(wm.pins).toHaveCount(2);
    await wm.expectPinOn(apollo.id, item('Apollo'));
    await wm.expectPinOn(header.id, brand);
    await expect(wm.pin(dana.id)).toHaveCount(0);
    await expect.poll(() => ext.badgeText(page)).toBe('2');

    // Forward to Team again.
    await page.goForward();
    await expect(page).toHaveURL(teamUrl);
    await expect.poll(async () => (await ext.pageState(page)).resolvedIds).toEqual([dana.id]);
    await expect(wm.pins).toHaveCount(1);
    await wm.expectPinOn(dana.id, item('Dana Whitfield'));
    await expect.poll(() => ext.badgeText(page)).toBe('1');

    // A full reload of a client-side route shows that route's notes.
    await wm.reload();
    await expect.poll(async () => (await ext.pageState(page)).resolvedIds).toEqual([dana.id]);
    await expect.poll(() => ext.badgeText(page)).toBe('1');
  });
});
