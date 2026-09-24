import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { browser, type Browser } from 'wxt/browser';
import { isBackgroundMessage, sendToTab, type PageState } from '@/lib/messages';
import {
  getAllNotes,
  getNotesForPage,
  getScreenshot,
  getSettings,
  onNotesChanged,
  onSettingsChanged,
  saveSettings,
} from '@/lib/storage';
import { DEFAULT_SETTINGS, type Note, type Settings } from '@/lib/types';
import { showToast, type ToastOptions } from './toast';

type Tab = Browser.tabs.Tab;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type UpdateSettings = (patch: Partial<Settings>) => Promise<Settings>;

/**
 * Live settings. Returns [settings, update, ready]: `settings` holds
 * DEFAULT_SETTINGS until storage has been read (`ready` = false), `update`
 * applies the patch optimistically and persists it.
 */
export function useSettings(): [Settings, UpdateSettings, boolean] {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    let changed = false;
    const off = onSettingsChanged((next) => {
      if (!active) return;
      changed = true;
      setSettings(next);
      setReady(true);
    });
    getSettings().then(
      (initial) => {
        // A change event is newer than a read that was issued before it.
        if (!active || changed) return;
        setSettings(initial);
        setReady(true);
      },
      () => active && setReady(true),
    );
    return () => {
      active = false;
      off();
    };
  }, []);

  const update = useCallback<UpdateSettings>((patch) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    return saveSettings(patch);
  }, []);

  return [settings, update, ready];
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export interface NotesResult {
  notes: Note[];
  /** True until the first read from storage has finished. */
  loading: boolean;
}

const EMPTY_NOTES: Note[] = [];

/** Notes for one page (oldest first, the pin-number order), kept live. */
export function usePageNotes(pageKey: string | undefined): NotesResult {
  const [result, setResult] = useState<{ key: string | undefined; notes: Note[]; loading: boolean }>({
    key: pageKey,
    notes: EMPTY_NOTES,
    loading: pageKey !== undefined,
  });

  useEffect(() => {
    if (pageKey === undefined) {
      setResult({ key: undefined, notes: EMPTY_NOTES, loading: false });
      return;
    }
    let active = true;
    let changed = false;
    setResult((prev) => (prev.key === pageKey ? prev : { key: pageKey, notes: EMPTY_NOTES, loading: true }));

    const off = onNotesChanged((changes) => {
      const change = changes.find((c) => c.pageKey === pageKey);
      if (!active || !change) return;
      changed = true;
      setResult({ key: pageKey, notes: change.notes, loading: false });
    });
    getNotesForPage(pageKey).then(
      (notes) => {
        if (!active || changed) return;
        setResult({ key: pageKey, notes, loading: false });
      },
      () => active && setResult({ key: pageKey, notes: EMPTY_NOTES, loading: false }),
    );
    return () => {
      active = false;
      off();
    };
  }, [pageKey]);

  // Never hand out the previous page's notes while the new page loads.
  if (result.key !== pageKey) return { notes: EMPTY_NOTES, loading: pageKey !== undefined };
  return { notes: result.notes, loading: result.loading };
}

function byNewest(a: Note, b: Note) {
  return b.createdAt - a.createdAt;
}

/** Every note across all pages (newest first), kept live. */
export function useAllNotes(): NotesResult {
  const [notes, setNotes] = useState<Note[]>(EMPTY_NOTES);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let loaded = false;
    let request = 0;

    const load = () => {
      const id = ++request;
      getAllNotes().then(
        (all) => {
          if (!active || id !== request) return;
          loaded = true;
          setNotes(all);
          setLoading(false);
        },
        () => active && setLoading(false),
      );
    };

    const off = onNotesChanged((changes) => {
      if (!active) return;
      // Before the first read lands we can't merge safely: just read again.
      if (!loaded) return load();
      const changedPages = new Set(changes.map((c) => c.pageKey));
      setNotes((prev) =>
        [...prev.filter((n) => !changedPages.has(n.pageKey)), ...changes.flatMap((c) => c.notes)].sort(byNewest),
      );
    });
    load();
    return () => {
      active = false;
      off();
    };
  }, []);

  return { notes, loading };
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

export interface ScreenshotResult {
  /** JPEG data URL, once loaded. */
  src: string | undefined;
  loading: boolean;
}

/**
 * Load a note's screenshot only once `enabled` (e.g. when scrolled into view).
 * Pass `version` (e.g. note.updatedAt) to re-read after the note changes, in
 * case the screenshot was stored after the note.
 */
export function useScreenshot(noteId: string, enabled = true, version?: number): ScreenshotResult {
  const [result, setResult] = useState<{ key: string; src?: string }>();
  const key = `${noteId}@${version ?? ''}`;

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    getScreenshot(noteId).then(
      (src) => active && setResult({ key, src }),
      () => active && setResult({ key }),
    );
    return () => {
      active = false;
    };
  }, [noteId, key, enabled]);

  if (result?.key === key) return { src: result.src, loading: false };
  // Keep showing the previous image for the same note while re-reading.
  const previous = result?.key.startsWith(`${noteId}@`) ? result.src : undefined;
  return { src: previous, loading: enabled };
}

// ---------------------------------------------------------------------------
// Tabs and page state
// ---------------------------------------------------------------------------

/**
 * The active tab of the window this page lives in (popup or side panel),
 * following tab switches, navigations and title changes. Undefined until the
 * first query resolves.
 */
export function useActiveTab(): Tab | undefined {
  const [tab, setTab] = useState<Tab>();

  useEffect(() => {
    let active = true;
    let windowId: number | undefined;
    let currentTabId: number | undefined;

    const refresh = async () => {
      try {
        if (windowId === undefined) windowId = (await browser.windows.getCurrent()).id;
        const [next] = await browser.tabs.query(
          windowId !== undefined ? { active: true, windowId } : { active: true, currentWindow: true },
        );
        if (!active) return;
        currentTabId = next?.id;
        setTab(next);
      } catch {
        // Window closed while querying; the next event will refresh.
      }
    };

    const onActivated = (info: Browser.tabs.OnActivatedInfo) => {
      if (windowId === undefined || info.windowId === windowId) void refresh();
    };
    const onUpdated = (tabId: number, change: Browser.tabs.OnUpdatedInfo, updated: Tab) => {
      if (tabId !== currentTabId) return;
      if (change.url !== undefined || change.title !== undefined || change.status !== undefined) {
        setTab({ ...updated });
      }
    };
    const onReplaced = (_added: number, removed: number) => {
      // Chromium swaps in prerendered tabs under a new id.
      if (removed === currentTabId) void refresh();
    };
    const onFocusChanged = () => void refresh();

    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onReplaced?.addListener(onReplaced);
    browser.windows?.onFocusChanged.addListener(onFocusChanged);
    void refresh();

    return () => {
      active = false;
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onReplaced?.removeListener(onReplaced);
      browser.windows?.onFocusChanged.removeListener(onFocusChanged);
    };
  }, []);

  return tab;
}

export interface PageStateResult {
  /**
   * Last state reported by the tab's content script. It can briefly belong to
   * the previous page after a navigation: compare `state.pageKey` with the
   * page key you expect before trusting `resolvedIds` / `orphanedIds`.
   */
  state: PageState | undefined;
  /** Waiting for the content script (first query, page loading, retries). */
  loading: boolean;
  /** The tab has no WebMark content script (restricted page, or opened before install). */
  missing: boolean;
  /** Ask the content script again. */
  refresh: () => void;
}

/** Content scripts inject at document_idle, which can land just after "complete". */
const RETRY_DELAYS_MS = [250, 800];

interface PageStateSnapshot {
  tabId: number | undefined;
  state: PageState | undefined;
  loading: boolean;
  missing: boolean;
}

/** WebMark's state in a tab, from its content script, kept live. */
export function usePageState(tabId: number | undefined): PageStateResult {
  const [snapshot, setSnapshot] = useState<PageStateSnapshot>({
    tabId,
    state: undefined,
    loading: true,
    missing: false,
  });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (tabId === undefined) {
      setSnapshot({ tabId, state: undefined, loading: true, missing: false });
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;

    setSnapshot((prev) =>
      prev.tabId === tabId
        ? { ...prev, loading: true }
        : { tabId, state: undefined, loading: true, missing: false },
    );

    const query = async (attempt: number, gen: number) => {
      const state = await sendToTab(tabId, { type: 'wm:get-page-state' });
      if (!active || gen !== generation) return;
      if (state) {
        setSnapshot({ tabId, state, loading: false, missing: false });
        return;
      }
      const tab = await browser.tabs.get(tabId).catch(() => undefined);
      if (!active || gen !== generation) return;
      // Still loading: onUpdated(status: complete) will query again.
      if (tab?.status === 'loading') return;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) {
        timer = setTimeout(() => void query(attempt + 1, gen), delay);
        return;
      }
      setSnapshot({ tabId, state: undefined, loading: false, missing: true });
    };

    const restart = () => {
      if (timer) clearTimeout(timer);
      generation++;
      void query(0, generation);
    };

    const onUpdated = (id: number, change: Browser.tabs.OnUpdatedInfo) => {
      if (id !== tabId) return;
      if (change.status === 'loading') {
        if (timer) clearTimeout(timer);
        generation++;
        setSnapshot((prev) => ({ ...prev, tabId, loading: true, missing: false }));
      } else if (change.status === 'complete' || change.url !== undefined) {
        restart();
      }
    };

    const onMessage = (message: unknown, sender: Browser.runtime.MessageSender) => {
      if (!isBackgroundMessage(message) || message.type !== 'wm:page-state-changed') return;
      if (sender.tab?.id !== tabId || (sender.frameId !== undefined && sender.frameId !== 0)) return;
      if (timer) clearTimeout(timer);
      generation++;
      setSnapshot({ tabId, state: message.state, loading: false, missing: false });
      // No return value: the background is the one that responds to this message.
    };

    browser.tabs.onUpdated.addListener(onUpdated);
    browser.runtime.onMessage.addListener(onMessage);
    restart();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.runtime.onMessage.removeListener(onMessage);
    };
  }, [tabId, nonce]);

  if (snapshot.tabId !== tabId) return { state: undefined, loading: true, missing: false, refresh };
  return { state: snapshot.state, loading: snapshot.loading, missing: snapshot.missing, refresh };
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

/**
 * The shortcut currently bound to a manifest command, e.g. "Alt+Shift+M".
 * Uses `fallback` if the commands API is unavailable; returns '' when the user
 * removed the binding.
 */
export function useCommandShortcut(command: string, fallback = ''): string {
  const [shortcut, setShortcut] = useState(fallback);

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => browser.commands.getAll())
      .then(
        (commands) => {
          if (!active) return;
          const match = commands.find((c) => c.name === command);
          setShortcut(match ? (match.shortcut ?? '') : fallback);
        },
        () => active && setShortcut(fallback),
      );
    return () => {
      active = false;
    };
  }, [command, fallback]);

  return shortcut;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

interface Ticker {
  now: number;
  listeners: Set<() => void>;
  timer?: ReturnType<typeof setInterval>;
}

// One shared timer per interval, so a long list of cards doesn't run one each.
const tickers = new Map<number, Ticker>();

function getTicker(intervalMs: number): Ticker {
  let ticker = tickers.get(intervalMs);
  if (!ticker) {
    ticker = { now: Date.now(), listeners: new Set() };
    tickers.set(intervalMs, ticker);
  }
  return ticker;
}

function subscribeTicker(intervalMs: number, listener: () => void): () => void {
  const ticker = getTicker(intervalMs);
  ticker.listeners.add(listener);
  if (!ticker.timer) {
    ticker.now = Date.now();
    ticker.timer = setInterval(() => {
      ticker.now = Date.now();
      for (const notify of ticker.listeners) notify();
    }, intervalMs);
  }
  return () => {
    ticker.listeners.delete(listener);
    if (!ticker.listeners.size && ticker.timer) {
      clearInterval(ticker.timer);
      ticker.timer = undefined;
    }
  };
}

/** Current time, re-rendered every `intervalMs` so relative times stay fresh. */
export function useNow(intervalMs = 60_000): number {
  const subscribe = useCallback((listener: () => void) => subscribeTicker(intervalMs, listener), [intervalMs]);
  const getSnapshot = useCallback(() => getTicker(intervalMs).now, [intervalMs]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export type ShowToast = (message: string, options?: ToastOptions) => number;

/** Returns a stable `toast(message, { tone, duration })`. Render <Toaster /> once per page. */
export function useToast(): ShowToast {
  return showToast;
}

