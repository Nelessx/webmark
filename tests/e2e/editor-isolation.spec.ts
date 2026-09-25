import type { Browser } from 'wxt/browser';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { getPageKey } from '../../src/lib/url';
import { expect, NO_FRAMES_CSP, test } from './fixtures';
import { dashboard, openDashboard, WebMark } from './webmark';

/*
 * The note editor runs in WebMark's own extension page, framed inside the
 * closed shadow root, so a page can't observe what is typed. Pages that
 * block extension frames get the in-page editor with a warning instead.
 * Plus the in-page UI's other defences against hostile pages.
 */

declare const chrome: typeof Browser;

interface PageEvent {
  type: string;
  on: 'window' | 'document';
  phase: 'capture' | 'bubble';
  target: string;
  key: string | null;
  data: string | null;
}

/** Events that would reveal keystrokes or text: keys, input, clipboard and IME. */
const TYPING_EVENTS = new Set([
  'keydown',
  'keyup',
  'keypress',
  'beforeinput',
  'input',
  'paste',
  'copy',
  'cut',
  'compositionstart',
  'compositionupdate',
  'compositionend',
]);

const pageEvents = (page: Page) => page.evaluate(() => (window as unknown as { __events: PageEvent[] }).__events);
const activeElements = (page: Page) => page.evaluate(() => (window as unknown as { __activeElements: string[] }).__activeElements);

async function resetPageLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __events: unknown[]; __activeElements: string[] };
    w.__events.length = 0;
    w.__activeElements.length = 0;
  });
}

/** Everything a page script can read from its own DOM: text, attributes, field values, title, storage. */
function pageReadableText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [document.title, location.href, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) parts.push(node.nodeValue ?? '');
      if (node instanceof Element) for (const attr of node.attributes) parts.push(attr.value);
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) parts.push(node.value);
      node.childNodes.forEach(walk);
    };
    walk(document.documentElement);
    parts.push(...performance.getEntries().map((e) => e.name));
    return parts.join('\n');
  });
}

/** Type through the IME (as for Japanese or Chinese input): compositionstart … compositionend. */
async function typeWithIme(context: BrowserContext, page: Page, text: string): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  await cdp.send('Input.insertText', { text });
  await cdp.detach();
}

/** The editor sessions the background keeps in storage.session. */
function editorSessions(sw: Worker) {
  return sw.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.entries(all)
      .filter(([key]) => key.startsWith('wm:editor:'))
      .map(([, value]) => value as { request: { mode: string; draft?: { values: { body: string } } } });
  });
}

test.describe('isolated note editor', () => {
  test('what is typed into a note never reaches the page: keys, input, paste, IME, focus, DOM', async ({
    context,
    page,
    ext,
    server,
    sw,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin });
    const wm = new WebMark(page, ext);
    await wm.open(server.url('/isolation.html'));
    await page.evaluate(() => navigator.clipboard.writeText(' + pasted'));
    const search = page.locator('#search');
    await search.click();

    await wm.startPicker();
    await wm.pick(page.locator('#summary'));
    const editor = wm.editor('create');
    await expect.poll(() => wm.focusedField()).toBe('data-wm-body');

    // It is WebMark's editor page, framed through Chrome's per-session URL
    // (use_dynamic_url); the token it was given is already gone from its URL.
    const src = (await wm.editorFrame.getAttribute('src')) ?? '';
    const dynamicHost = new URL(src).host;
    expect(src).toMatch(/^chrome-extension:\/\/[0-9a-f-]{36}\/note-editor\.html#[0-9a-f]{32}$/);
    expect(dynamicHost).not.toBe(ext.id);
    expect((await wm.editorDocument())?.url()).toBe(ext.url('note-editor.html'));

    await resetPageLog(page);
    await page.keyboard.type('Secret plan');
    await page.keyboard.press('Enter');
    await page.keyboard.type('line twoo');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Control+V');
    await typeWithIme(context, page, 'に');
    await expect(editor.locator('[data-wm-body]')).toHaveValue('Secret plan\nline two + pastedに');

    // The page saw none of it, and its focus never went further than WebMark's host.
    const typing = (await pageEvents(page)).filter((e) => TYPING_EVENTS.has(e.type));
    expect(typing).toEqual([]);
    expect((await activeElements(page)).filter((name) => name !== 'webmark-ui')).toEqual([]);
    // Nothing of it is readable in the page, nor even in WebMark's shadow root (open in this build).
    expect(await pageReadableText(page)).not.toContain('Secret plan');
    expect(await page.evaluate(() => document.querySelector('[data-wm-host]')?.shadowRoot?.textContent)).not.toContain('Secret');
    // The page can't reach the frame: frames in a shadow tree aren't in window.frames.
    expect(await page.evaluate(() => window.length)).toBe(0);
    expect(await pageReadableText(page)).not.toContain(dynamicHost);

    await page.keyboard.press('Control+Enter');
    await expect(editor).toBeHidden();
    const [note] = await ext.notes(page);
    expect(note).toMatchObject({ body: 'Secret plan\nline two + pastedに', pageKey: getPageKey(page.url()) });
    await expect(wm.pin(note!.id)).toBeVisible();
    // Focus is back where it was. (The Ctrl+Enter key-ups may reach it once the editor has gone.)
    await expect(search).toBeFocused();
    const afterwards = (await pageEvents(page)).filter((e) => TYPING_EVENTS.has(e.type) && e.type !== 'keyup');
    expect(afterwards).toEqual([]);
    expect(await pageReadableText(page)).not.toContain('Secret plan');
    await expect.poll(async () => (await editorSessions(sw)).length).toBe(0);
  });

  test('a frame the page creates itself gets no session: replayed or made-up tokens, or the page opened directly', async ({
    context,
    page,
    ext,
    server,
    errorLog,
  }) => {
    const wm = new WebMark(page, ext);
    await wm.open(server.url('/isolation.html'));
    await wm.startPicker();
    await wm.pick(page.locator('#summary'));
    await expect.poll(() => wm.focusedField()).toBe('data-wm-body');
    await page.keyboard.type('Only for WebMark');

    // Only readable because this build's shadow root is open: the frame's URL, token included.
    const src = (await wm.editorFrame.getAttribute('src')) ?? '';
    const made = (id: string, url: string) =>
      page.evaluate(
        ({ id, url }) => {
          const frame = document.createElement('iframe');
          frame.id = id;
          frame.src = url;
          document.body.append(frame);
        },
        { id, url },
      );
    await made('replayed', src);
    await made('made-up', src.replace(/#.*/, `#${'0'.repeat(32)}`));
    for (const id of ['replayed', 'made-up']) {
      const frame = page.frameLocator(`#${id}`);
      await expect(frame.locator('body[data-wm-denied]')).toHaveCount(1);
      await expect(frame.locator('[data-wm-editor]')).toHaveCount(0);
    }
    // The static URL (a store extension's id is public) isn't served to pages at all.
    const logged = errorLog.errors.length;
    await made('static', ext.url('note-editor.html'));
    await expect.poll(() => page.frame({ url: /chrome-error/ }) !== null).toBe(true);
    // Chrome logs that refusal; it is this test's doing.
    errorLog.errors.splice(logged).forEach((error) => expect(error).toMatch(/note-editor\.html/));

    // Opened in a tab of its own, it isn't framed in a page: nothing either.
    const tab = await context.newPage();
    await tab.goto(`${ext.url('note-editor.html')}#${'1'.repeat(32)}`);
    await expect(tab.locator('body[data-wm-denied]')).toHaveCount(1);
    await expect(tab.locator('[data-wm-editor]')).toHaveCount(0);
    expect(tab.url()).toBe(ext.url('note-editor.html'));
    await tab.close();

    // WebMark's own editor is unaffected.
    await page.bringToFront();
    await wm.editor().locator('[data-wm-body]').click();
    await page.keyboard.press('Control+Enter');
    await expect(wm.editor()).toBeHidden();
    await expect.poll(async () => (await ext.notes(page))[0]?.body).toBe('Only for WebMark');
  });

  test("a page whose CSP allows no frames still gets the isolated editor (Chrome exempts extension frames)", async ({
    page,
    ext,
    server,
    errorLog,
  }) => {
    await page.addInitScript(() => {
      const violations: string[] = [];
      (window as unknown as { __violations: string[] }).__violations = violations;
      document.addEventListener('securitypolicyviolation', (e) => violations.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    const wm = new WebMark(page, ext);
    const response = await page.goto(server.url('/no-frames-plan.html'));
    expect(response?.headers()['content-security-policy']).toBe(NO_FRAMES_CSP);
    await ext.waitForContentScript(page);

    const note = await wm.createNote(page.locator('#summary'), 'Frames are blocked here, but not ours');
    expect(note.hasScreenshot).toBe(true);
    expect((await pageEvents(page)).filter((e) => TYPING_EVENTS.has(e.type))).toEqual([]);
    expect(await wm.pageValue<string[]>('__violations')).toEqual([]);

    // The policy is enforced for the page's own frames.
    const logged = errorLog.errors.length;
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.src = location.href;
      document.body.append(frame);
    });
    await expect.poll(() => wm.pageValue<string[]>('__violations')).toEqual([expect.stringMatching(/^frame-src /)]);
    // Chrome logs that refusal; it is this test's doing.
    await expect.poll(() => errorLog.errors.length).toBe(logged + 1);
    expect(errorLog.errors.splice(logged)).toEqual([expect.stringContaining("violates the following Content Security Policy directive: \"frame-src 'none'\"")]);
  });

  test('where the page blocks extension frames (COEP), the in-page editor takes over and says typing is visible', async ({
    context,
    page,
    ext,
    server,
  }) => {
    const wm = new WebMark(page, ext);
    const response = await page.goto(server.url('/coep-plan.html'));
    expect(response?.headers()['cross-origin-embedder-policy']).toBe('require-corp');
    await ext.waitForContentScript(page);
    wm.editorSurface = 'inline';

    await wm.startPicker();
    await wm.pick(page.locator('#summary'));
    const editor = wm.editor('create');
    await expect(editor).toBeVisible();
    await expect(editor.locator('[data-wm-insecure]')).toHaveText('Typing here is visible to this page.');
    await expect(wm.editorFrame).toHaveCount(0);
    // The session the frame never claimed can't be claimed any more.
    await expect.poll(async () => (await editorSessions(await ext.worker())).length).toBe(1);

    await expect.poll(() => wm.focusedField()).toBe('data-wm-body');
    await resetPageLog(page);
    await page.keyboard.type('Still saved');
    await typeWithIme(context, page, 'よ');
    // Page listeners in the capture phase can't be kept out of the page's own
    // document (hence the warning); bubbling ones never get our events.
    const events = await pageEvents(page);
    expect(events.filter((e) => e.phase === 'capture' && e.type === 'keydown').length).toBeGreaterThan(0);
    expect(events.filter((e) => e.phase === 'bubble')).toEqual([]);

    await page.keyboard.press('Control+Enter');
    await expect(editor).toBeHidden();
    await expect.poll(async () => (await ext.notes(page))[0]?.body).toBe('Still savedよ');
    await expect.poll(async () => (await editorSessions(await ext.worker())).length).toBe(0);
  });
});

test.describe('in-page UI defences', () => {
  test('pins and the editor line up on a page whose <body> is transformed, and page rules cannot restyle WebMark', async ({
    page,
    ext,
    server,
  }) => {
    const wm = new WebMark(page, ext);
    await wm.open(server.url('/transformed.html'));
    const alpha = page.locator('#alpha');
    await alpha.scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 150);

    await wm.startPicker();
    await wm.pick(alpha.locator('h3'), { up: 1, expected: alpha });
    // The editor sits right next to the tile.
    await expect.poll(async () => {
      const [frame, tile] = [await wm.editorFrame.boundingBox(), await alpha.boundingBox()];
      return frame && tile ? Math.round(frame.x - (tile.x + tile.width)) : null;
    }).toBe(10);
    await wm.write('Tile needs an icon');
    const [note] = await ext.notes(page);
    await wm.expectPinOn(note!.id, alpha);
    // Still in place after scrolling the transformed body.
    await page.mouse.wheel(0, 120);
    await wm.expectPinOn(note!.id, alpha);

    // `webmark-ui { --wm-…: … !important }` on the page changes nothing.
    const pin = await wm.pin(note!.id).evaluate((el) => {
      const s = getComputedStyle(el);
      return { background: s.backgroundColor, font: s.fontFamily };
    });
    expect(pin.background).not.toBe('rgb(255, 0, 0)');
    expect(pin.font).toBe('system-ui, sans-serif');
  });

  test("a page that defines <webmark-ui> first can't reach WebMark's shadow root", async ({ page, ext, server }) => {
    const wm = new WebMark(page, ext);
    await wm.open(server.url('/custom-element.html'));
    const host = await page.evaluate(() => document.querySelector('[data-wm-host]')?.localName);
    expect(host).toMatch(/^webmark-ui-[0-9a-z]{8}$/);
    expect(await page.locator('[data-wm-host]').count()).toBe(1);

    const note = await wm.createNote(page.locator('#item'), 'Tag after the changelog');
    await wm.expectPinOn(note.id, page.locator('#item'));
    // The constructor ran on WebMark's first host, which was discarded before anything went into it.
    expect(await wm.pageValue<number>('__constructed')).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as unknown as { __stolen(): string }).__stolen())).not.toContain('Tag after');
    const reachesLiveRoot = await page.evaluate(() => {
      const live = document.querySelector('[data-wm-host]')?.shadowRoot;
      const collected = (window as unknown as { __internals: ElementInternals[] }).__internals;
      return collected.some((internals) => internals.shadowRoot !== null && internals.shadowRoot === live);
    });
    expect(reachesLiveRoot).toBe(false);

    // Defining the random name now (upgrading WebMark's host) gives nothing either.
    const late = await page.evaluate((tag) => {
      let stolen = 'none';
      customElements.define(
        tag!,
        class extends HTMLElement {
          constructor() {
            super();
            try {
              stolen = String(this.attachInternals().shadowRoot?.textContent ?? 'null');
            } catch (error) {
              stolen = `refused: ${(error as Error).name}`;
            }
          }
        },
      );
      return stolen;
    }, host);
    expect(late).not.toContain('Tag after the changelog');
    expect(['null', 'none']).toContain(late.startsWith('refused') ? 'none' : late);
  });

  test("a page can't learn the extension id from WXT's start-up handshake, nor use it to switch WebMark off", async ({
    page,
    ext,
    server,
  }) => {
    await page.addInitScript(() => {
      const messages: string[] = [];
      (window as unknown as { __messages: string[] }).__messages = messages;
      window.addEventListener('message', (e) => messages.push(JSON.stringify(e.data)));
    });
    const wm = new WebMark(page, ext);
    await wm.open(server.url('/isolation.html'));
    const first = await wm.createNote(page.locator('#summary'), 'Before the forged event');
    expect((await wm.pageValue<string[]>('__messages')).join('\n')).not.toContain(ext.id);

    // What WXT dispatches when a newer copy of the content script starts.
    await page.evaluate((id) => {
      document.dispatchEvent(
        new CustomEvent(`${id}:content:wxt:content-script-started`, {
          detail: { contentScriptName: 'content', messageId: 'forged' },
        }),
      );
    }, ext.id);

    await expect(wm.pin(first.id)).toBeVisible();
    const second = await wm.createNote(page.locator('h2'), 'After the forged event');
    await wm.expectPinOn(second.id, page.locator('h2'));
  });

  test("notes can be written for elements in a page's modal dialog, which makes the rest of the page inert", async ({
    page,
    ext,
    server,
  }) => {
    const wm = new WebMark(page, ext);
    await wm.open(server.url('/modal.html'));
    const plan = page.locator('#plan');
    const behind = await wm.createNote(plan, 'Seats are billed monthly');
    await wm.expectPinOn(behind.id, plan);

    await wm.waitForClickGuard();
    await page.locator('#open').click();
    const dialog = page.locator('#profile');
    await expect(dialog).toBeVisible();
    // WebMark's host joins the dialog (so it isn't inert); pins of what is behind it are hidden.
    const hostParent = () => page.evaluate(() => document.querySelector('[data-wm-host]')?.parentElement?.id || document.querySelector('[data-wm-host]')?.parentElement?.localName);
    await expect.poll(hostParent).toBe('profile');
    await expect(wm.pin(behind.id)).toHaveCount(0);

    const name = page.locator('#display-name');
    const inDialog = await wm.createNote(name, 'Show the pronouns too');
    await wm.expectPinOn(inDialog.id, name);
    // Typing and saving neither closed the dialog nor tripped its focus trap.
    await expect(dialog).toBeVisible();
    expect(await wm.pageValue<number>('__trapped')).toBe(0);

    await wm.waitForClickGuard();
    await page.locator('#close').click();
    await expect(dialog).toBeHidden();
    await expect.poll(hostParent).toBe('body');
    await wm.expectPinOn(behind.id, plan);
    await expect(wm.pin(inDialog.id)).toHaveCount(0);
  });

  test("the picker's Cancel button and the wm:stop-picker message leave picking mode", async ({ page, ext, server }) => {
    const wm = new WebMark(page, ext);
    await wm.open(server.url('/dashboard.html'));

    await wm.startPicker();
    await page.locator('[data-wm-picker-cancel]').click();
    await expect(wm.pickerHint).toBeHidden();
    expect((await ext.pageState(page)).pickerActive).toBe(false);
    expect(await wm.pageValue<number>('__clicks')).toBe(0);

    // The side panel has the keyboard when it starts picking, so Esc there has to send this.
    await wm.startPicker();
    expect(await ext.send(page, { type: 'wm:stop-picker' })).toEqual({ ok: true });
    await expect(wm.pickerHint).toBeHidden();
    expect((await ext.pageState(page)).pickerActive).toBe(false);
  });
});

test.describe('unsaved drafts', () => {
  test('SPA navigation keeps a note with changes open, and saves it to the page it was written on', async ({
    page,
    ext,
    server,
  }) => {
    const wm = new WebMark(page, ext);
    const projectsUrl = server.url('/spa.html');
    const teamUrl = server.url('/spa.html?view=team');
    await wm.open(projectsUrl);
    const apollo = page.getByRole('heading', { level: 3, name: 'Apollo', exact: true }).locator('xpath=..');

    // An untouched editor closes on navigation...
    await wm.startPicker();
    await wm.pick(apollo.locator('p'), { up: 1, expected: apollo });
    await expect.poll(() => wm.focusedField()).toBe('data-wm-body');
    await page.evaluate(() => history.pushState(null, '', '/spa.html?view=team'));
    await expect(wm.editor()).toBeHidden();
    await page.goBack();
    await expect(page).toHaveURL(projectsUrl);
    await expect.poll(async () => (await ext.pageState(page)).pageKey).toBe(getPageKey(projectsUrl));

    // ...one with changes stays open through it.
    await wm.startPicker();
    await wm.pick(apollo.locator('p'), { up: 1, expected: apollo });
    await expect.poll(() => wm.focusedField()).toBe('data-wm-body');
    await page.keyboard.type('Apollo launch date?');
    await wm.waitForClickGuard();
    await page.getByRole('link', { name: 'Team' }).click();
    await expect(page).toHaveURL(teamUrl);
    await expect.poll(async () => (await ext.pageState(page)).pageKey).toBe(getPageKey(teamUrl));
    const editor = wm.editor('create');
    await expect(editor.locator('[data-wm-body]')).toHaveValue('Apollo launch date?');

    await editor.locator('[data-wm-body]').click();
    await page.keyboard.press('Control+Enter');
    await expect(editor).toBeHidden();
    const [note] = await ext.notes(getPageKey(projectsUrl));
    expect(note).toMatchObject({ body: 'Apollo launch date?', url: projectsUrl, pageTitle: 'Projects · Workspace' });
    expect(await ext.notes(getPageKey(teamUrl))).toEqual([]);
  });

  test('a page swapping its <body> mid-note (Turbo, pjax) reloads the editor frame; the note carries on', async ({
    page,
    ext,
    server,
    sw,
  }) => {
    const wm = new WebMark(page, ext);
    await openDashboard(wm, server.url('/dashboard.html'));
    const d = dashboard(page);
    await wm.startPicker();
    await wm.pick(d.cardValue('Refunds'), { up: 1, expected: d.card('Refunds') });
    await expect.poll(() => wm.focusedField()).toBe('data-wm-body');
    await page.keyboard.type('Written before the swap');
    await expect
      .poll(async () => (await editorSessions(sw)).map((s) => s.request.draft?.values.body))
      .toContain('Written before the swap');

    // WebMark's host is put back into the new <body>, which reloads the frame
    // inside it: its single-use session is spent, so a new one takes over.
    await page.evaluate(() => (window as unknown as { __swapBody(): void }).__swapBody());
    const editor = wm.editor('create');
    await expect(editor.locator('[data-wm-body]')).toHaveValue('Written before the swap');
    await expect.poll(() => wm.focusedField()).toBe('data-wm-body');
    await page.keyboard.type(', and after it');
    await page.keyboard.press('Control+Enter');
    await expect(editor).toBeHidden();

    await expect.poll(async () => (await ext.notes(page))[0]?.body).toBe('Written before the swap, and after it');
    const [note] = await ext.notes(page);
    await wm.expectPinOn(note!.id, d.card('Refunds'));
    await expect.poll(async () => (await editorSessions(sw)).length).toBe(0);
  });

  test('a reload with an unsaved note brings it back, and a saved one never comes back', async ({ page, ext, server, sw }) => {
    const wm = new WebMark(page, ext);
    await wm.open(server.url('/isolation.html'));
    await wm.startPicker();
    await wm.pick(page.locator('#summary'));
    await expect.poll(() => wm.focusedField()).toBe('data-wm-body');
    await page.keyboard.type('Half a thought');
    // Mirrored (throttled) into storage.session through the background.
    await expect
      .poll(async () => (await editorSessions(sw)).map((s) => s.request.draft?.values.body))
      .toEqual(['Half a thought']);

    await wm.reload();
    const editor = wm.editor('create');
    await expect(editor.locator('[data-wm-body]')).toHaveValue('Half a thought');
    await expect(page.locator('[data-wm-toast]').last()).toHaveText('Restored an unsaved note');
    await expect.poll(() => wm.focusedField()).toBe('data-wm-body');
    await page.keyboard.type(', now whole');
    await page.keyboard.press('Control+Enter');
    await expect(editor).toBeHidden();
    const [note] = await ext.notes(page);
    expect(note?.body).toBe('Half a thought, now whole');
    await wm.expectPinOn(note!.id, page.locator('#summary'));

    await wm.reload();
    await expect(wm.pin(note!.id)).toBeVisible();
    await expect(wm.editorFrame).toHaveCount(0);
    expect(await editorSessions(sw)).toEqual([]);
  });
});
