import { browser, type Browser, type PublicPath } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { captureElement } from '@/lib/capture';
import { getActionApi, getMenusApi, openDashboard } from '@/lib/compat';
import { handleEditorMessage } from '@/lib/editor/handler';
import { EditorSessions } from '@/lib/editor/sessions';
import {
  isBackgroundMessage,
  isEditorBackgroundMessage,
  listen,
  sendToTab,
  type BackgroundMessage,
  type BackgroundResponse,
  type CaptureResult,
  type ContentMessage,
  type ContentResponse,
  type PageState,
} from '@/lib/messages';
import { canRunOn, getPageKey } from '@/lib/url';
// --- Storage writer, reveal, context menu frames ---
import { revealNoteInBrowser } from '@/lib/compat';
import { addNoteMenuMessage } from '@/lib/menus';
import { registerStorageWriter } from '@/lib/storage';

type Tab = Browser.tabs.Tab;
type Sender = Browser.runtime.MessageSender;

// Typed as plain strings: these files are emitted by other entrypoints and are
// missing from PublicPath until `wxt prepare` sees them.
const CONTENT_SCRIPT_FILE: string = '/content-scripts/content.js';
const DASHBOARD_PAGE: string = '/options.html';

const MENU_ADD_NOTE = 'wm-add-note';
const MENU_TOGGLE_PINS = 'wm-toggle-pins';
const COMMAND_START_PICKER = 'start-picker';
const COMMAND_TOGGLE_PINS = 'toggle-pins';

const BADGE_COLOR = '#5b4cf5';
const BADGE_TEXT_COLOR = '#ffffff';
const BADGE_WARNING_COLOR = '#d14343';
const BADGE_WARNING_MS = 2000;

/** How long to wait for a freshly injected content script to answer. */
const INJECT_READY_TIMEOUT_MS = 2000;
const INJECT_POLL_MS = 100;
/** Delay before re-reading page state after a navigation (lets SPA content scripts catch up). */
const BADGE_REFRESH_DELAY_MS = 800;

export default defineBackground({
  // Firefox MV2: an event page instead of a persistent background page.
  persistent: false,
  main() {
    // Every listener is registered synchronously: an MV3 service worker that
    // wakes up for an event only dispatches it to listeners added before the
    // first await.
    browser.runtime.onInstalled.addListener(onInstalled);
    browser.runtime.onStartup.addListener(() => void setUpMenus());
    getMenusApi()?.onClicked.addListener(onMenuClicked);
    browser.commands?.onCommand.addListener(onCommand);
    browser.tabs.onUpdated.addListener(onTabUpdated);
    browser.tabs.onRemoved.addListener(forgetTab);
    listen(isBackgroundMessage, handleMessage);
    // --- Note editor sessions ---
    browser.tabs.onRemoved.addListener((tabId) => void editorSessions().forgetTab(tabId));
    // --- Storage writer: every context's writes run here, one at a time (see src/lib/storage.ts) ---
    registerStorageWriter();
  },
});

// --- Note editor sessions (see src/lib/editor/protocol.ts) -----------------

let sessions: EditorSessions | undefined;
/** Created on first use: the build imports this module outside a browser. */
const editorSessions = () => (sessions ??= new EditorSessions());

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------

function onInstalled(details: Browser.runtime.InstalledDetails): void {
  void setUpMenus();
  if (details.reason !== 'install' && details.reason !== 'update') return;
  void injectIntoOpenTabs();
  if (details.reason === 'install') {
    void browser.tabs.create({ url: browser.runtime.getURL(DASHBOARD_PAGE as PublicPath) + '#welcome' }).catch(() => {});
  }
}

/**
 * Tabs opened before install/update have no (or an orphaned) content script
 * until reloaded. Inject one so notes and pins work right away.
 */
async function injectIntoOpenTabs(): Promise<void> {
  let tabs: Tab[];
  try {
    tabs = await browser.tabs.query({});
  } catch {
    return;
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined || tab.discarded || !canRunOn(tab.url)) return;
      if (await isContentScriptReady(tab.id)) return;
      await injectContentScript(tab.id);
    }),
  );
}

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------

const MENU_ITEMS: Browser.contextMenus.CreateProperties[] = [
  { id: MENU_ADD_NOTE, title: 'Add WebMark note to this element', contexts: ['all'] },
  { id: MENU_TOGGLE_PINS, title: 'Show / hide WebMark pins', contexts: ['all'] },
];

/** Chained so onInstalled and onStartup firing together can't interleave remove/create. */
let menuSetup: Promise<void> = Promise.resolve();

function setUpMenus(): Promise<void> {
  menuSetup = menuSetup.then(createMenus, createMenus);
  return menuSetup;
}

async function createMenus(): Promise<void> {
  const menus = getMenusApi();
  if (!menus) return;
  try {
    await menus.removeAll();
  } catch {
    // Nothing to remove.
  }
  for (const item of MENU_ITEMS) {
    try {
      // Reading lastError marks a duplicate-id error as handled instead of logging it.
      menus.create(item, () => void browser.runtime.lastError);
    } catch {
      // Firefox may throw synchronously for a duplicate id; the item exists either way.
    }
  }
}

function onMenuClicked(info: Browser.contextMenus.OnClickData, tab?: Tab): void {
  // A right-click inside an iframe starts the picker in the top frame (see addNoteMenuMessage).
  if (info.menuItemId === MENU_ADD_NOTE) void deliver(tab, addNoteMenuMessage(info.frameId));
  else if (info.menuItemId === MENU_TOGGLE_PINS) void deliver(tab, { type: 'wm:set-pins-visible' });
}

// ---------------------------------------------------------------------------
// Keyboard commands
// ---------------------------------------------------------------------------

async function onCommand(command: string, tab?: Tab): Promise<void> {
  const message = commandMessage(command);
  if (!message) return;
  const target = tab?.id !== undefined && tab.id >= 0 ? tab : await getActiveTabSafe();
  await deliver(target, message);
}

function commandMessage(command: string): ContentMessage | undefined {
  if (command === COMMAND_START_PICKER) return { type: 'wm:start-picker' };
  if (command === COMMAND_TOGGLE_PINS) return { type: 'wm:set-pins-visible' };
  return undefined;
}

async function getActiveTabSafe(): Promise<Tab | undefined> {
  try {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    return tab;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Delivering messages to content scripts (injecting one if it is missing)
// ---------------------------------------------------------------------------

/**
 * Send a message to a tab's content script. If the tab has none (opened before
 * install, or the script was orphaned by an update) inject it and retry once.
 * On pages WebMark can't run on, flash a warning badge instead.
 */
async function deliver<M extends ContentMessage>(
  tab: Tab | undefined,
  message: M,
): Promise<ContentResponse<M> | undefined> {
  const tabId = tab?.id;
  if (tabId === undefined || tabId < 0) return undefined;

  const first = await sendToTab(tabId, message);
  if (first !== undefined) return first;

  if (!canRunOn(tab?.url)) {
    void flashWarningBadge(tabId);
    return undefined;
  }
  // A live script that simply answered nothing must not be injected twice.
  if (await isContentScriptReady(tabId)) return undefined;

  if (!(await injectContentScript(tabId)) || !(await waitForContentScript(tabId))) {
    void flashWarningBadge(tabId);
    return undefined;
  }
  return sendToTab(tabId, message);
}

async function isContentScriptReady(tabId: number): Promise<boolean> {
  return (await sendToTab(tabId, { type: 'wm:get-page-state' })) !== undefined;
}

async function waitForContentScript(tabId: number): Promise<boolean> {
  const deadline = Date.now() + INJECT_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isContentScriptReady(tabId)) return true;
    await sleep(INJECT_POLL_MS);
  }
  return false;
}

type LegacyTabsApi = {
  executeScript(tabId: number, details: { file: string }): Promise<unknown>;
};

async function injectContentScript(tabId: number): Promise<boolean> {
  try {
    // `scripting` exists on Chromium MV3 and Firefox 102+; older Firefox only has tabs.executeScript.
    if (browser.scripting?.executeScript) {
      await browser.scripting.executeScript({
        target: { tabId },
        files: [CONTENT_SCRIPT_FILE as Extract<PublicPath, `${string}.js`>],
      });
    } else {
      await (browser.tabs as unknown as LegacyTabsApi).executeScript(tabId, { file: CONTENT_SCRIPT_FILE });
    }
    return true;
  } catch {
    // Restricted page, discarded tab, or no file access permission.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Messages from content scripts / extension pages
// ---------------------------------------------------------------------------

async function handleMessage(message: BackgroundMessage, sender: Sender): Promise<BackgroundResponse<BackgroundMessage>> {
  // --- Note editor sessions ---
  if (isEditorBackgroundMessage(message)) return handleEditorMessage(editorSessions(), message, sender);
  switch (message.type) {
    case 'wm:capture-element':
      return handleCapture(message, sender);
    case 'wm:page-state-changed':
      return handlePageState(message.state, sender);
    case 'wm:open-dashboard':
      await openDashboard(message.noteId);
      return { ok: true };
    // --- Storage / reveal ---
    case 'wm:reveal-note':
      return handleRevealNote(message, sender);
  }
}

async function handleCapture(
  message: Extract<BackgroundMessage, { type: 'wm:capture-element' }>,
  sender: Sender,
): Promise<CaptureResult> {
  const tab = sender.tab;
  if (!tab || tab.id === undefined || tab.windowId === undefined) return { error: 'Screenshots can only be taken from a page' };
  // The rect is relative to the sending frame, so it only matches the capture for the top frame.
  if (sender.frameId !== undefined && sender.frameId !== 0) return { error: 'Screenshots are only supported in the top frame' };
  // captureVisibleTab shoots whatever tab is showing, which must be the sender;
  // captureElement checks that again around every capture.
  if (!tab.active) return { error: 'The tab must be visible to take a screenshot' };
  return captureElement({ tabId: tab.id, windowId: tab.windowId }, message.rect, message.devicePixelRatio);
}

// --- Storage / reveal ---------------------------------------------------------

/** Dashboard "Open on page". Only WebMark's own pages may ask: it switches tabs and opens pages. */
async function handleRevealNote(
  message: Extract<BackgroundMessage, { type: 'wm:reveal-note' }>,
  sender: Sender,
): Promise<{ ok: boolean }> {
  if (!sender.url?.startsWith(browser.runtime.getURL('/' as PublicPath))) return { ok: false };
  if (typeof message.pageKey !== 'string' || typeof message.noteId !== 'string') return { ok: false };
  const ok = await revealNoteInBrowser(
    { pageKey: message.pageKey, noteId: message.noteId },
    {
      windowId: sender.tab?.windowId,
      injectContentScript: async (tabId) => {
        const injected = await injectContentScript(tabId);
        if (!injected) void flashWarningBadge(tabId);
        return injected;
      },
    },
  );
  return { ok };
}

async function handlePageState(state: PageState, sender: Sender): Promise<{ ok: boolean }> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || tabId < 0) return { ok: false };
  if (sender.frameId !== undefined && sender.frameId !== 0) return { ok: false };
  await showOpenCount(tabId, state.openCount);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Toolbar badge (per tab)
// ---------------------------------------------------------------------------

/** Last count text per tab, so a warning flash can restore it. */
const badgeTexts = new Map<number, string>();
const warningTimers = new Map<number, ReturnType<typeof setTimeout>>();

async function showOpenCount(tabId: number, openCount: number): Promise<void> {
  const text = Number.isFinite(openCount) && openCount > 0 ? String(Math.floor(openCount)) : '';
  badgeTexts.set(tabId, text);
  // The warning restores the latest count when it ends.
  if (warningTimers.has(tabId)) return;
  await setBadge(tabId, text, BADGE_COLOR);
}

async function setBadge(tabId: number, text: string, color: string): Promise<void> {
  const action = getActionApi();
  try {
    await action.setBadgeBackgroundColor({ tabId, color });
    // setBadgeTextColor: Chrome 110+, Firefox 63+.
    if (typeof action.setBadgeTextColor === 'function') {
      await action.setBadgeTextColor({ tabId, color: BADGE_TEXT_COLOR });
    }
    await action.setBadgeText({ tabId, text });
  } catch {
    // The tab closed in the meantime.
  }
}

/** Badge text currently shown, for when the worker restarted and forgot it. */
async function readBadgeText(tabId: number): Promise<string> {
  try {
    const text = await getActionApi().getBadgeText({ tabId });
    return text === '!' ? '' : text;
  } catch {
    return '';
  }
}

/** Briefly show "!" when WebMark can't run on the page the user acted on. */
async function flashWarningBadge(tabId: number): Promise<void> {
  if (!warningTimers.has(tabId) && !badgeTexts.has(tabId)) {
    const text = await readBadgeText(tabId);
    // A state report may have arrived while reading; it is newer.
    if (!badgeTexts.has(tabId)) badgeTexts.set(tabId, text);
  }
  clearTimeout(warningTimers.get(tabId));
  warningTimers.set(
    tabId,
    setTimeout(() => {
      warningTimers.delete(tabId);
      void setBadge(tabId, badgeTexts.get(tabId) ?? '', BADGE_COLOR);
    }, BADGE_WARNING_MS),
  );
  await setBadge(tabId, '!', BADGE_WARNING_COLOR);
}

function onTabUpdated(tabId: number, changeInfo: Browser.tabs.OnUpdatedInfo): void {
  if (changeInfo.status !== 'loading') return;
  // The content script of the new page reports fresh state; until then show nothing.
  void showOpenCount(tabId, 0);
  setTimeout(() => void refreshBadge(tabId), BADGE_REFRESH_DELAY_MS);
}

/**
 * Same-document navigations (SPA routes, hash changes) also report "loading",
 * but their content script survives and may not report again if the page key
 * didn't change. Ask it directly, and trust the answer only if it describes
 * the page the tab is on now.
 */
async function refreshBadge(tabId: number): Promise<void> {
  const state = await sendToTab(tabId, { type: 'wm:get-page-state' });
  if (!state) return;
  let tab: Tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    return;
  }
  if (tab.url && getPageKey(tab.url) === state.pageKey) await showOpenCount(tabId, state.openCount);
}

function forgetTab(tabId: number): void {
  badgeTexts.delete(tabId);
  const pending = warningTimers.get(tabId);
  if (pending !== undefined) clearTimeout(pending);
  warningTimers.delete(tabId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
