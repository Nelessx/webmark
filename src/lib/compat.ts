import { browser, type Browser } from 'wxt/browser';
import { sendToTab } from './messages';
import { setPendingFocus } from './storage';
import { getPageKey } from './url';
import type { Note } from './types';

/*
 * Small wrappers over APIs that differ between Chromium (MV3) and Firefox (MV2).
 */

type ActionApi = typeof browser.action;

/** `browser.action` on MV3, `browser.browserAction` on Firefox MV2. */
export function getActionApi(): ActionApi {
  return (browser.action ?? (browser as unknown as { browserAction: ActionApi }).browserAction) as ActionApi;
}

/** `browser.contextMenus` on Chromium, `browser.menus` on Firefox. */
export function getMenusApi(): typeof browser.contextMenus {
  return (browser.contextMenus ?? (browser as unknown as { menus: typeof browser.contextMenus }).menus) as typeof browser.contextMenus;
}

export async function getActiveTab(): Promise<Browser.tabs.Tab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * Open the WebMark side panel (Chromium) or sidebar (Firefox).
 * Must be called directly from a user gesture handler (e.g. a button click in
 * the popup), otherwise the browser rejects it.
 */
export async function openSidePanel(windowId?: number): Promise<void> {
  if (import.meta.env.FIREFOX) {
    const sidebar = (browser as unknown as { sidebarAction?: { open(): Promise<void> } }).sidebarAction;
    await sidebar?.open();
    return;
  }
  const sidePanel = (browser as unknown as { sidePanel?: { open(options: { windowId: number }): Promise<void> } })
    .sidePanel;
  if (!sidePanel) return;
  const id = windowId ?? (await browser.windows.getCurrent()).id;
  if (id !== undefined) await sidePanel.open({ windowId: id });
}

/** Open the dashboard (the options page) in a tab, optionally highlighting a note. */
export async function openDashboard(noteId?: string): Promise<void> {
  const url = browser.runtime.getURL('/options.html') + (noteId ? `#note=${encodeURIComponent(noteId)}` : '');
  await browser.tabs.create({ url });
}

/**
 * Take the user to a note: if an open tab already shows the note's page, focus
 * that tab and ask its content script to reveal the note; otherwise open the
 * page in a new tab and let the content script pick up the pending focus on load.
 */
export async function revealNote(note: Note): Promise<void> {
  const tabs = await browser.tabs.query({});
  const active = await getActiveTab();
  const candidates = tabs
    .filter((t) => t.id !== undefined && t.url && getPageKey(t.url) === note.pageKey)
    // Prefer the active tab, then tabs in the current window.
    .sort((a, b) => Number(b.id === active?.id) - Number(a.id === active?.id) || Number(b.windowId === active?.windowId) - Number(a.windowId === active?.windowId));

  const tab = candidates[0];
  if (tab?.id !== undefined) {
    await browser.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
    const res = await sendToTab(tab.id, { type: 'wm:focus-note', noteId: note.id });
    if (res) return;
    // No content script in that tab yet: fall back to reloading it with a pending focus.
    await setPendingFocus(note.pageKey, note.id);
    await browser.tabs.reload(tab.id);
    return;
  }
  await setPendingFocus(note.pageKey, note.id);
  await browser.tabs.create({ url: note.url });
}
