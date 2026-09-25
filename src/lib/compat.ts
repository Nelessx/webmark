import { browser, type Browser } from 'wxt/browser';
import { sendToBackground, sendToTab } from './messages';
import { getNote, setPendingFocus, takePendingFocus, type NoteRef } from './storage';
import { getPageKey, isPageUrl } from './url';
import type { Note } from './types';

/*
 * Small wrappers over APIs that differ between Chromium (MV3) and Firefox (MV2).
 */

type ActionApi = typeof browser.action;
type Tab = Browser.tabs.Tab;

/** `browser.action` on MV3, `browser.browserAction` on Firefox MV2. */
export function getActionApi(): ActionApi {
  return (browser.action ?? (browser as unknown as { browserAction: ActionApi }).browserAction) as ActionApi;
}

/** `browser.contextMenus` on Chromium, `browser.menus` on Firefox. */
export function getMenusApi(): typeof browser.contextMenus {
  return (browser.contextMenus ?? (browser as unknown as { menus: typeof browser.contextMenus }).menus) as typeof browser.contextMenus;
}

export async function getActiveTab(): Promise<Tab | undefined> {
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
 * Take the user to a note (dashboard "Open on page"). The background does the
 * work, since only it can inject a content script into a tab that has none.
 */
export async function revealNote(note: Note): Promise<void> {
  const res = await sendToBackground({ type: 'wm:reveal-note', pageKey: note.pageKey, noteId: note.id });
  if (!res?.ok) throw new Error("Couldn't show the note on its page");
}

export interface RevealOptions {
  /** Window the request came from: its tabs are preferred. */
  windowId?: number;
  /** Inject WebMark's content script into a tab; false where the page doesn't allow it. */
  injectContentScript(tabId: number): Promise<boolean>;
}

/**
 * Background side of revealNote(). If a tab already shows the note's page,
 * focus it and have its content script reveal the note; a tab without one
 * (opened before install or update) gets one injected, which picks the note
 * up like a fresh page load. The user's tab is never reloaded. Only when no
 * tab shows the page does it open in a new one. Resolves false when the note
 * can't be shown.
 */
export async function revealNoteInBrowser(ref: NoteRef, options: RevealOptions): Promise<boolean> {
  const note = await getNote(ref.pageKey, ref.noteId);
  if (!note) return false;

  const tab = await findTabShowing(note.pageKey, options.windowId);
  if (tab?.id !== undefined) {
    await browser.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
    if (await sendToTab(tab.id, { type: 'wm:focus-note', noteId: note.id })) return true;
    await setPendingFocus(note.pageKey, note.id);
    if (await options.injectContentScript(tab.id)) return true;
    await takePendingFocus(note.pageKey);
    return false;
  }

  // Saved URLs come from pages WebMark ran on; never open anything else.
  if (!isPageUrl(note.url)) return false;
  await setPendingFocus(note.pageKey, note.id);
  await browser.tabs.create({ url: note.url, ...(options.windowId !== undefined ? { windowId: options.windowId } : {}) });
  return true;
}

/** A tab showing `pageKey`, preferring one in `windowId`. */
async function findTabShowing(pageKey: string, windowId: number | undefined): Promise<Tab | undefined> {
  const tabs = (await browser.tabs.query({})).filter((t) => t.id !== undefined && t.url && getPageKey(t.url) === pageKey);
  return tabs.find((t) => t.windowId === windowId) ?? tabs[0];
}
