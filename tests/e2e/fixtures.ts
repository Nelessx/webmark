import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Worker,
} from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'wxt/browser';
import type { ContentMessage, ContentResponse, PageState } from '../../src/lib/messages';
import type { Note, Settings } from '../../src/lib/types';
import { getPageKey } from '../../src/lib/url';

/*
 * One Chromium (Playwright's bundled build, which still honours
 * --load-extension) per worker with the `wxt build --mode e2e` output loaded.
 * In that build the in-page UI uses an OPEN shadow root, so locators reach it.
 * Every test gets a fresh tab and an empty chrome.storage.local.
 */

/** The `chrome` global of the extension service worker. Only valid inside sw.evaluate() callbacks. */
declare const chrome: typeof Browser;

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const EXTENSION_DIR = path.join(ROOT, '.output', 'chrome-mv3-e2e');
const PAGES_DIR = path.join(ROOT, 'tests', 'e2e', 'pages');

// ---------------------------------------------------------------------------
// Static server for tests/e2e/pages
// ---------------------------------------------------------------------------

export interface StaticServer {
  origin: string;
  /** Absolute URL of a test page, e.g. url('/dashboard.html'). */
  url(pathname: string): string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/** Served with strict-*.html: no inline scripts or styles, images only from the page's own origin. */
export const STRICT_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";

async function startStaticServer(): Promise<StaticServer & { close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');
    // basename(): only files directly inside pages/ are served.
    const name = path.basename(decodeURIComponent(pathname));
    if (name === 'favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    const file = path.join(PAGES_DIR, name);
    readFile(file).then(
      (body) => {
        const headers: Record<string, string> = {
          'content-type': CONTENT_TYPES[path.extname(name)] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        };
        if (name.startsWith('strict-')) headers['content-security-policy'] = STRICT_CSP;
        res.writeHead(200, headers);
        res.end(body);
      },
      () => {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    url: (pathname) => new URL(pathname, origin).href,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // The browser keeps idle keep-alive connections open.
        server.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------------------
// Talking to the extension through its service worker
// ---------------------------------------------------------------------------

export class Extension {
  constructor(
    readonly context: BrowserContext,
    readonly id: string,
  ) {}

  /** chrome-extension:// URL of an extension page, e.g. url('options.html#welcome'). */
  url(pathname: string): string {
    return `chrome-extension://${this.id}/${pathname.replace(/^\//, '')}`;
  }

  /** The live service worker (the newest one, after an extension reload). */
  async worker(): Promise<Worker> {
    const prefix = `chrome-extension://${this.id}/`;
    const live = this.context
      .serviceWorkers()
      .filter((w) => w.url().startsWith(prefix))
      .at(-1);
    return live ?? this.context.waitForEvent('serviceworker', { predicate: (w) => w.url().startsWith(prefix) });
  }

  async clearStorage(): Promise<void> {
    await (await this.worker()).evaluate(() => chrome.storage.local.clear());
  }

  async storage(keys: string | string[] | null = null): Promise<Record<string, unknown>> {
    return (await this.worker()).evaluate((k) => chrome.storage.local.get(k), keys);
  }

  /** Stored notes for a page key (or the page a tab shows), oldest first. */
  async notes(target: string | Page): Promise<Note[]> {
    const pageKey = typeof target === 'string' ? target : getPageKey(target.url());
    const key = `wm:notes:${pageKey}`;
    const stored = (await this.storage(key))[key] as Note[] | undefined;
    return [...(stored ?? [])].sort((a, b) => a.createdAt - b.createdAt);
  }

  async note(target: string | Page, noteId: string): Promise<Note | undefined> {
    return (await this.notes(target)).find((n) => n.id === noteId);
  }

  async settings(): Promise<Partial<Settings>> {
    return ((await this.storage('wm:settings'))['wm:settings'] as Partial<Settings> | undefined) ?? {};
  }

  /** The tab id of a page, found by URL. */
  async tabId(page: Page): Promise<number> {
    const url = page.url();
    const tabs = await (
      await this.worker()
    ).evaluate(async (u) => (await chrome.tabs.query({})).filter((t) => t.url === u).map((t) => ({ id: t.id, active: t.active })), url);
    const tab = tabs.length > 1 ? tabs.find((t) => t.active) : tabs[0];
    if (tab?.id === undefined) throw new Error(`No tab (or no unique tab) shows ${url}: ${JSON.stringify(tabs)}`);
    return tab.id;
  }

  /** Send a ContentMessage to a page's content script, as the popup / background do. */
  async send<M extends ContentMessage>(page: Page, message: M): Promise<ContentResponse<M>> {
    const tabId = await this.tabId(page);
    return (await this.worker()).evaluate(
      ({ id, msg }) => chrome.tabs.sendMessage(id, msg, { frameId: 0 }),
      { id: tabId, msg: message as ContentMessage },
    ) as Promise<ContentResponse<M>>;
  }

  async pageState(page: Page): Promise<PageState> {
    return this.send(page, { type: 'wm:get-page-state' });
  }

  /** Wait until the page's content script answers for the page's current URL. */
  async waitForContentScript(page: Page): Promise<PageState> {
    let state: PageState | undefined;
    await expect
      .poll(
        async () => {
          state = await this.pageState(page).catch(() => undefined);
          return state?.pageKey;
        },
        { message: `content script on ${page.url()}`, timeout: 15_000 },
      )
      .toBe(getPageKey(page.url()));
    return state as PageState;
  }

  async badgeText(page: Page): Promise<string> {
    const tabId = await this.tabId(page);
    return (await this.worker()).evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  }

  /** Browser zoom for this tab only (per-origin zoom would leak into later tests). */
  async setZoom(page: Page, factor: number): Promise<void> {
    const tabId = await this.tabId(page);
    await (
      await this.worker()
    ).evaluate(
      async ({ id, zoom }) => {
        await chrome.tabs.setZoomSettings(id, { mode: 'automatic', scope: 'per-tab' });
        await chrome.tabs.setZoom(id, zoom);
      },
      { id: tabId, zoom: factor },
    );
  }

  /**
   * chrome.runtime.reload(): what an extension update does. Resolves with the
   * new service worker. Chrome re-checks unpacked extensions on reload and
   * disables them ("not listed in the Chrome Web Store") unless Developer
   * mode is on, so switch that on first.
   */
  async reloadExtension(): Promise<Worker> {
    const settings = await this.context.newPage();
    await settings.goto('chrome://extensions');
    await settings.evaluate(() => {
      const toolbar = document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-toolbar');
      const toggle = toolbar?.shadowRoot?.querySelector<HTMLElement & { checked: boolean }>('#devMode');
      if (!toggle) throw new Error('Developer mode toggle not found on chrome://extensions');
      if (!toggle.checked) toggle.click();
    });
    await settings.close();

    const old = await this.worker();
    const prefix = `chrome-extension://${this.id}/`;
    const next = this.context.waitForEvent('serviceworker', { predicate: (w) => w !== old && w.url().startsWith(prefix) });
    // The worker is torn down mid-call.
    await old.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
    return next;
  }
}

// ---------------------------------------------------------------------------
// Error log: pages must not throw, and extension code must not log errors
// ---------------------------------------------------------------------------

export interface ErrorLog {
  readonly errors: string[];
}

/**
 * Errors that count: anything on extension pages; on web pages, anything that
 * mentions WebMark or does not come from the test page's own scripts (content
 * script messages carry the bundle URL, or no URL at all). The test pages
 * themselves never log errors.
 */
function isReportable(message: ConsoleMessage, page: Page, testOrigin: string): boolean {
  if (message.type() !== 'error') return false;
  // Browser pages (chrome://extensions) are not ours.
  if (page.url().startsWith('chrome://')) return false;
  if (page.url().startsWith('chrome-extension://')) return true;
  const source = message.location().url ?? '';
  return /webmark/i.test(message.text()) || !source.startsWith(testOrigin);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface WorkerFixtures {
  extensionContext: BrowserContext;
  extensionId: string;
  /** URLs of the tabs the extension opened when it was installed. */
  installTabs: string[];
  server: StaticServer;
}

interface TestFixtures {
  context: BrowserContext;
  page: Page;
  sw: Worker;
  ext: Extension;
  errorLog: ErrorLog;
  /** Every test starts with a single blank tab and an empty chrome.storage.local. */
  blankPage: Page;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  extensionContext: [
    async ({}, use) => {
      if (!existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) {
        throw new Error(`No E2E build at ${EXTENSION_DIR}. Run "npx wxt build --mode e2e" (npm run test:e2e does).`);
      }
      const userDataDir = await mkdtemp(path.join(tmpdir(), 'webmark-e2e-'));
      const context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        headless: !process.env.HEADED,
        // No viewport emulation: captureVisibleTab must see what the page lays out.
        viewport: null,
        args: [
          `--disable-extensions-except=${EXTENSION_DIR}`,
          `--load-extension=${EXTENSION_DIR}`,
          '--window-size=1280,900',
        ],
      });
      await use(context);
      await context.close();
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    },
    { scope: 'worker' },
  ],

  extensionId: [
    async ({ extensionContext }, use) => {
      const sw =
        extensionContext.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) ??
        (await extensionContext.waitForEvent('serviceworker'));
      await use(new URL(sw.url()).host);
    },
    { scope: 'worker' },
  ],

  installTabs: [
    async ({ extensionContext, extensionId }, use) => {
      // onInstalled opens the welcome screen; wait for it so it can't steal the active tab later.
      const prefix = `chrome-extension://${extensionId}/`;
      const opened = () => extensionContext.pages().filter((p) => p.url().startsWith(prefix));
      const deadline = Date.now() + 10_000;
      while (!opened().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      const pages = opened();
      const urls = pages.map((p) => p.url());
      if (extensionContext.pages().length === pages.length) await extensionContext.newPage();
      for (const page of pages) await page.close();
      await use(urls);
    },
    { scope: 'worker' },
  ],

  server: [
    async ({}, use) => {
      const server = await startStaticServer();
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],

  context: async ({ extensionContext, installTabs }, use) => {
    void installTabs;
    await use(extensionContext);
  },

  ext: async ({ context, extensionId }, use) => {
    await use(new Extension(context, extensionId));
  },

  sw: async ({ ext }, use) => {
    await use(await ext.worker());
  },

  errorLog: [
    async ({ context, ext, server }, use) => {
      const errors: string[] = [];
      const watch = (page: Page) => {
        page.on('pageerror', (error) => errors.push(`pageerror on ${page.url()}: ${error.stack ?? error.message}`));
        page.on('console', (message) => {
          if (isReportable(message, page, server.origin)) {
            errors.push(`console.error on ${page.url()}: ${message.text()} @ ${message.location().url}`);
          }
        });
      };
      const onWorkerConsole = (message: ConsoleMessage) => {
        if (message.type() === 'error') errors.push(`service worker console.error: ${message.text()}`);
      };
      const workers = new Set<Worker>();
      const watchWorker = (worker: Worker) => {
        workers.add(worker);
        worker.on('console', onWorkerConsole);
      };
      context.pages().forEach(watch);
      context.on('page', watch);
      watchWorker(await ext.worker());
      context.on('serviceworker', watchWorker);

      await use({ errors });

      context.off('page', watch);
      context.off('serviceworker', watchWorker);
      workers.forEach((worker) => worker.off('console', onWorkerConsole));
      expect(errors, 'page errors / WebMark console errors').toEqual([]);
    },
    { auto: true },
  ],

  blankPage: [
    async ({ context, ext, errorLog }, use) => {
      void errorLog;
      const page = await context.newPage();
      // Close the previous test's tabs only now: a window without tabs would end the browser.
      for (const other of context.pages()) if (other !== page) await other.close().catch(() => undefined);
      await ext.clearStorage();
      await use(page);
    },
    { auto: true },
  ],

  page: async ({ blankPage }, use) => {
    await use(blankPage);
  },
});

export { expect };
