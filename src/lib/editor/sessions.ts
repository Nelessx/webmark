import { browser, type Browser, type PublicPath } from 'wxt/browser';
import {
  EDITOR_HELLO_TTL_MS,
  EDITOR_PAGE_PATH,
  isEditorToken,
  type DraftState,
  type EditorHelloResponse,
  type EditorRequest,
} from './protocol';
import { isDraftState, isEditorRequest } from './validate';

/*
 * Background registry of note editor sessions (see protocol.ts).
 *
 * Records are mirrored into storage.session when it exists: an MV3 service
 * worker (or Firefox event page) is stopped when idle, and an editor can stay
 * open for minutes. storage.session is in memory, cleared when the browser or
 * the extension restarts, and not readable by content scripts. Unsaved drafts
 * live in the same records, so a reloaded page can offer them back.
 */

type Sender = Browser.runtime.MessageSender;

interface SessionRecord {
  token: string;
  tabId: number;
  /** Document of the content script that opened the session (Chrome only). */
  documentId?: string;
  createdAt: number;
  updatedAt: number;
  request: EditorRequest;
  /** The editor frame that claimed the session with its hello. */
  frameId?: number;
  /** The content script uses its in-page editor instead: no frame may claim the session any more. */
  inline?: boolean;
}

interface SessionArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

const KEY_PREFIX = 'wm:editor:';
/** The pick-time screenshot, stored once: drafts rewrite the record every few hundred ms. */
const SHOT_PREFIX = 'wm:editor-shot:';
/** Sessions untouched for this long are dropped, drafts included. */
const MAX_IDLE_MS = 12 * 60 * 60 * 1000;
const EXTENSION_PROTOCOLS = new Set(['chrome-extension:', 'moz-extension:', 'safari-web-extension:']);

const keyFor = (token: string) => KEY_PREFIX + token;
const shotKeyFor = (token: string) => SHOT_PREFIX + token;

function sessionArea(): SessionArea | undefined {
  const area = browser.storage?.session as SessionArea | undefined;
  return typeof area?.get === 'function' ? area : undefined;
}

function parseUrl(url: string | undefined): URL | null {
  try {
    return url ? new URL(url) : null;
  } catch {
    return null;
  }
}

/** Hosts our own pages can have: the extension id, or Firefox's per-install UUID. */
function ownHosts(): Set<string> {
  const hosts = new Set<string>([browser.runtime.id]);
  for (const path of ['/', EDITOR_PAGE_PATH]) {
    const url = parseUrl(browser.runtime.getURL(path as PublicPath));
    if (url) hosts.add(url.host);
  }
  return hosts;
}

/** The tab of a content script in a tab's top frame (not one of our own pages). */
export function contentScriptTab(sender: Sender): number | undefined {
  const tabId = sender.tab?.id;
  if (tabId === undefined || tabId < 0 || sender.frameId !== 0) return undefined;
  const url = parseUrl(sender.url);
  if (!url || EXTENSION_PROTOCOLS.has(url.protocol)) return undefined;
  return tabId;
}

/** WebMark's editor page, framed inside a tab. */
export function isEditorFrame(sender: Sender): boolean {
  if (sender.id !== browser.runtime.id) return false;
  const tabId = sender.tab?.id;
  if (tabId === undefined || tabId < 0 || sender.frameId === undefined || sender.frameId === 0) return false;
  const url = parseUrl(sender.url);
  return !!url && EXTENSION_PROTOCOLS.has(url.protocol) && url.pathname === EDITOR_PAGE_PATH && ownHosts().has(url.host);
}

function isRecord(value: unknown): value is SessionRecord {
  return typeof value === 'object' && value !== null && isEditorToken((value as SessionRecord).token);
}

export class EditorSessions {
  private readonly cache = new Map<string, SessionRecord>();
  /** Everything runs one at a time, so a token can't be claimed twice by racing hellos. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly area: SessionArea | undefined = sessionArea(),
    private readonly now: () => number = Date.now,
  ) {}

  /** Register a session for the content script's tab. Tokens are single use. */
  open(token: string, request: unknown, sender: Sender): Promise<boolean> {
    return this.run(async () => {
      const tabId = contentScriptTab(sender);
      if (tabId === undefined || !isEditorToken(token) || !isEditorRequest(request)) return false;
      if (await this.load(token)) return false;
      await this.purge();
      const now = this.now();
      await this.save({ token, tabId, documentId: sender.documentId, createdAt: now, updatedAt: now, request }, true);
      return true;
    });
  }

  /**
   * An editor frame presents its token. Accepted once, from WebMark's editor
   * page framed in the same tab, within EDITOR_HELLO_TTL_MS of the open.
   */
  hello(token: string, sender: Sender): Promise<EditorHelloResponse> {
    return this.run(async () => {
      const record = isEditorToken(token) ? await this.load(token) : undefined;
      if (!record || record.frameId !== undefined || record.inline) return { ok: false };
      if (this.now() - record.createdAt > EDITOR_HELLO_TTL_MS) {
        await this.delete(token);
        return { ok: false };
      }
      if (!isEditorFrame(sender) || sender.tab?.id !== record.tabId) return { ok: false };
      record.frameId = sender.frameId;
      record.updatedAt = this.now();
      await this.save(record);
      return { ok: true, session: { request: record.request, tabId: record.tabId } };
    });
  }

  /** The tab to relay a frame's event to, if the sender is the frame that claimed the session. */
  frameTab(token: string, sender: Sender): Promise<number | undefined> {
    return this.run(async () => {
      const record = await this.load(token);
      return record && this.isSessionFrame(record, sender) ? record.tabId : undefined;
    });
  }

  /**
   * The content script gave up on the frame: no frame may claim or speak for
   * the session any more. Returns what the frame last mirrored, so editing
   * can go on (in a new frame, or in the page) from there.
   */
  fallback(token: string, sender: Sender): Promise<{ ok: boolean; draft?: DraftState }> {
    return this.run(async () => {
      const record = await this.load(token);
      if (!record || contentScriptTab(sender) !== record.tabId) return { ok: false };
      record.inline = true;
      delete record.frameId;
      record.updatedAt = this.now();
      await this.save(record);
      return record.request.draft ? { ok: true, draft: record.request.draft } : { ok: true };
    });
  }

  /** Remember (or, with null, forget) the unsaved values of a session. */
  draft(token: string, draft: unknown, sender: Sender): Promise<boolean> {
    return this.run(async () => {
      const record = await this.load(token);
      if (!record || (draft !== null && !isDraftState(draft))) return false;
      const fromPage = record.inline === true && contentScriptTab(sender) === record.tabId;
      if (!fromPage && !this.isSessionFrame(record, sender)) return false;
      record.request = withDraft(record.request, draft);
      record.updatedAt = this.now();
      await this.save(record);
      return true;
    });
  }

  /** The note was saved or discarded: the draft has nothing left to recover. */
  settle(token: string): Promise<void> {
    return this.run(async () => {
      const record = await this.load(token);
      if (!record?.request.draft) return;
      record.request = withDraft(record.request, null);
      await this.save(record);
    });
  }

  close(token: string, sender: Sender): Promise<boolean> {
    return this.run(async () => {
      const record = await this.load(token);
      if (!record) return false;
      if (contentScriptTab(sender) !== record.tabId && !this.isSessionFrame(record, sender)) return false;
      await this.delete(token);
      return true;
    });
  }

  /**
   * A content script that just started asks for an unsaved draft its tab left
   * behind on this page (reload, or navigating away and back). Sessions of
   * other documents in the tab are over; those without a draft are dropped.
   */
  recover(pageKey: string, sender: Sender): Promise<EditorRequest | undefined> {
    return this.run(async () => {
      const tabId = contentScriptTab(sender);
      if (tabId === undefined || typeof pageKey !== 'string') return undefined;
      const stale = (await this.all()).filter(
        (r) => r.tabId === tabId && (!sender.documentId || r.documentId !== sender.documentId),
      );
      let best: SessionRecord | undefined;
      for (const record of stale) {
        if (record.request.draft && record.request.page.pageKey === pageKey && (!best || record.updatedAt > best.updatedAt)) {
          best = record;
        }
      }
      for (const record of stale) if (record === best || !record.request.draft) await this.delete(record.token);
      return best?.request;
    });
  }

  forgetTab(tabId: number): Promise<void> {
    return this.run(async () => {
      for (const record of await this.all()) if (record.tabId === tabId) await this.delete(record.token);
    });
  }

  private isSessionFrame(record: SessionRecord, sender: Sender): boolean {
    return (
      record.frameId !== undefined &&
      sender.frameId === record.frameId &&
      sender.tab?.id === record.tabId &&
      isEditorFrame(sender)
    );
  }

  /** Drop sessions nobody claimed in time and ones idle for too long. */
  private async purge(): Promise<void> {
    const now = this.now();
    for (const record of await this.all()) {
      const unclaimed = record.frameId === undefined && !record.inline && !record.request.draft;
      if (now - record.updatedAt > MAX_IDLE_MS || (unclaimed && now - record.createdAt > EDITOR_HELLO_TTL_MS)) {
        await this.delete(record.token);
      }
    }
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async load(token: string): Promise<SessionRecord | undefined> {
    const cached = this.cache.get(token);
    if (cached || !this.area || !isEditorToken(token)) return cached;
    try {
      const stored = await this.area.get([keyFor(token), shotKeyFor(token)]);
      const record = restored(stored, keyFor(token));
      if (record) this.cache.set(token, record);
      return record;
    } catch {
      return undefined;
    }
  }

  private async all(): Promise<SessionRecord[]> {
    const records = new Map(this.cache);
    if (this.area) {
      try {
        const stored = await this.area.get(null);
        for (const key of Object.keys(stored)) {
          const record = key.startsWith(KEY_PREFIX) ? restored(stored, key) : undefined;
          if (record && !records.has(record.token)) records.set(record.token, record);
        }
      } catch {
        // Only what this instance remembers, then.
      }
    }
    return [...records.values()];
  }

  /** Remember a record here and in storage.session; the screenshot goes there only once, `withShot`. */
  private async save(record: SessionRecord, withShot = false): Promise<void> {
    this.cache.set(record.token, record);
    const { request } = record;
    const items: Record<string, unknown> = { [keyFor(record.token)]: record };
    if (request.mode === 'create' && request.screenshot) {
      const { screenshot, ...lean } = request;
      items[keyFor(record.token)] = { ...record, request: lean };
      if (withShot) items[shotKeyFor(record.token)] = screenshot;
    }
    try {
      await this.area?.set(items);
    } catch {
      // storage.session full or gone: the in-memory copy still works while we run.
    }
  }

  private async delete(token: string): Promise<void> {
    this.cache.delete(token);
    try {
      await this.area?.remove([keyFor(token), shotKeyFor(token)]);
    } catch {
      // Nothing stored.
    }
  }
}

/** A record read back from storage.session, with its screenshot put back in. */
function restored(stored: Record<string, unknown>, key: string): SessionRecord | undefined {
  const record = stored[key];
  if (!isRecord(record)) return undefined;
  const shot = stored[shotKeyFor(record.token)];
  if (record.request.mode !== 'create' || typeof shot !== 'string') return record;
  return { ...record, request: { ...record.request, screenshot: shot } };
}

function withDraft(request: EditorRequest, draft: DraftState | null): EditorRequest {
  const next = { ...request };
  if (draft) next.draft = draft;
  else delete next.draft;
  return next;
}
