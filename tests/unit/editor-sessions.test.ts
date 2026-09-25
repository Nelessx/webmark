import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { handleEditorMessage } from '@/lib/editor/handler';
import { EDITOR_HELLO_TTL_MS, createEditorToken, type DraftState, type EditorRequest } from '@/lib/editor/protocol';
import { EditorSessions } from '@/lib/editor/sessions';
import { isEditorFrameEvent, isEditorRequest } from '@/lib/editor/validate';
import type { ElementAnchor } from '@/lib/types';

/*
 * The background's side of the isolated editor: who may open a session,
 * which frame may claim it (once, in time), whose events are relayed, and
 * how unsaved drafts are kept and recovered.
 */

type Sender = Browser.runtime.MessageSender;

const TAB = 7;
const FRAME = 3;
const EXT = 'chrome-extension://test-extension-id';

const page = { pageKey: 'https://example.com/page', url: 'https://example.com/page?x=1', title: 'Example' };
const createRequest: EditorRequest = {
  mode: 'create',
  page,
  label: 'Revenue card',
  anchor: { selector: '#revenue', tagName: 'div' } as ElementAnchor,
  screenshot: 'data:image/jpeg;base64,AAAA',
};
const editRequest: EditorRequest = { mode: 'edit', page, label: 'Users card', noteId: 'n1' };
const draft: DraftState = {
  initial: { label: 'Revenue card', body: '', tags: '', status: 'open', priority: 'medium' },
  values: { label: 'Revenue card', body: 'Half a thought', tags: '', status: 'open', priority: 'high' },
};

function contentScript(overrides: Partial<Sender> = {}): Sender {
  return { id: 'test-extension-id', tab: { id: TAB } as Sender['tab'], frameId: 0, url: page.url, documentId: 'doc-1', ...overrides };
}

function editorFrame(overrides: Partial<Sender> = {}): Sender {
  return { id: 'test-extension-id', tab: { id: TAB } as Sender['tab'], frameId: FRAME, url: `${EXT}/note-editor.html#t`, ...overrides };
}

let now = 1_000_000;
const clock = () => now;

beforeEach(() => {
  fakeBrowser.reset();
  now = 1_000_000;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('opening a session', () => {
  it('takes requests from a content script in the top frame of a tab, with a fresh well-formed token', async () => {
    const sessions = new EditorSessions(undefined, clock);
    const token = createEditorToken();
    expect(await sessions.open(token, createRequest, contentScript())).toBe(true);
    // Tokens are never reused.
    expect(await sessions.open(token, createRequest, contentScript())).toBe(false);

    expect(await sessions.open(createEditorToken(), createRequest, contentScript({ frameId: 2 }))).toBe(false);
    expect(await sessions.open(createEditorToken(), createRequest, contentScript({ tab: undefined }))).toBe(false);
    // An extension page in a tab is not a content script.
    expect(await sessions.open(createEditorToken(), createRequest, contentScript({ url: `${EXT}/options.html` }))).toBe(false);
    expect(await sessions.open('not-a-token', createRequest, contentScript())).toBe(false);
    expect(await sessions.open(createEditorToken(), { ...createRequest, screenshot: 'https://evil.example/x.jpg' }, contentScript())).toBe(false);
    expect(await sessions.open(createEditorToken(), { mode: 'edit', page, label: 'x' }, contentScript())).toBe(false);
  });
});

describe("the editor frame's hello", () => {
  it("is answered once, for WebMark's editor page framed in the tab that opened the session", async () => {
    const sessions = new EditorSessions(undefined, clock);
    const token = createEditorToken();
    await sessions.open(token, createRequest, contentScript());

    // Not the editor page, a top frame, another tab, or another extension's page: nothing.
    expect(await sessions.hello(token, editorFrame({ url: `${EXT}/options.html` }))).toEqual({ ok: false });
    expect(await sessions.hello(token, editorFrame({ url: 'https://example.com/note-editor.html' }))).toEqual({ ok: false });
    expect(await sessions.hello(token, editorFrame({ frameId: 0 }))).toEqual({ ok: false });
    expect(await sessions.hello(token, editorFrame({ tab: { id: TAB + 1 } as Sender['tab'] }))).toEqual({ ok: false });
    expect(await sessions.hello(token, editorFrame({ id: 'other-extension' }))).toEqual({ ok: false });
    expect(await sessions.hello(token, editorFrame({ url: 'chrome-extension://other-id/note-editor.html' }))).toEqual({ ok: false });

    expect(await sessions.hello(token, editorFrame())).toEqual({ ok: true, session: { request: createRequest, tabId: TAB } });
    // Single use: not even the same frame gets it twice.
    expect(await sessions.hello(token, editorFrame())).toEqual({ ok: false });
    expect(await sessions.hello(createEditorToken(), editorFrame())).toEqual({ ok: false });
  });

  it('must come within the time limit, and racing hellos claim a session once', async () => {
    const sessions = new EditorSessions(undefined, clock);
    const late = createEditorToken();
    await sessions.open(late, createRequest, contentScript());
    now += EDITOR_HELLO_TTL_MS + 1;
    expect(await sessions.hello(late, editorFrame())).toEqual({ ok: false });

    const raced = createEditorToken();
    await sessions.open(raced, createRequest, contentScript());
    const results = await Promise.all([sessions.hello(raced, editorFrame()), sessions.hello(raced, editorFrame({ frameId: 9 }))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe('relaying and ending sessions', () => {
  it("relays only the claiming frame's events, to its tab", async () => {
    const sessions = new EditorSessions(undefined, clock);
    const token = createEditorToken();
    await sessions.open(token, createRequest, contentScript());
    expect(await sessions.frameTab(token, editorFrame())).toBeUndefined();
    await sessions.hello(token, editorFrame());
    expect(await sessions.frameTab(token, editorFrame())).toBe(TAB);
    expect(await sessions.frameTab(token, editorFrame({ frameId: FRAME + 1 }))).toBeUndefined();
    expect(await sessions.frameTab(token, contentScript())).toBeUndefined();

    // The tab's content script or the frame may close it; nobody else.
    expect(await sessions.close(token, contentScript({ tab: { id: TAB + 1 } as Sender['tab'] }))).toBe(false);
    expect(await sessions.close(token, contentScript())).toBe(true);
    expect(await sessions.frameTab(token, editorFrame())).toBeUndefined();
  });

  it('after a fallback no frame can claim the session, and the page itself sends the drafts', async () => {
    const sessions = new EditorSessions(undefined, clock);
    const token = createEditorToken();
    await sessions.open(token, createRequest, contentScript());
    expect(await sessions.draft(token, draft, contentScript())).toBe(false);
    expect(await sessions.fallback(token, contentScript({ tab: { id: TAB + 1 } as Sender['tab'] }))).toEqual({ ok: false });
    expect(await sessions.fallback(token, contentScript())).toEqual({ ok: true });
    expect(await sessions.hello(token, editorFrame())).toEqual({ ok: false });
    expect(await sessions.draft(token, draft, editorFrame())).toBe(false);
    expect(await sessions.draft(token, draft, contentScript())).toBe(true);
  });

  it('a frame that broke hands back what it had mirrored, and can no longer speak for the session', async () => {
    const sessions = new EditorSessions(undefined, clock);
    const token = createEditorToken();
    await sessions.open(token, createRequest, contentScript());
    await sessions.hello(token, editorFrame());
    await sessions.draft(token, draft, editorFrame());
    expect(await sessions.fallback(token, contentScript())).toEqual({ ok: true, draft });
    expect(await sessions.frameTab(token, editorFrame())).toBeUndefined();
    expect(await sessions.draft(token, draft, editorFrame())).toBe(false);
  });

  it("forgets a closed tab's sessions", async () => {
    const sessions = new EditorSessions(undefined, clock);
    const token = createEditorToken();
    await sessions.open(token, createRequest, contentScript());
    await sessions.forgetTab(TAB);
    expect(await sessions.hello(token, editorFrame())).toEqual({ ok: false });
  });
});

describe('unsaved drafts', () => {
  it("are recovered once by the tab's next document on the same page, until saved or discarded", async () => {
    const sessions = new EditorSessions(fakeBrowser.storage.session, clock);
    const token = createEditorToken();
    await sessions.open(token, createRequest, contentScript());
    await sessions.hello(token, editorFrame());
    expect(await sessions.draft(token, { ...draft, values: { ...draft.values, tags: 42 } }, editorFrame())).toBe(false);
    expect(await sessions.draft(token, draft, editorFrame({ frameId: FRAME + 1 }))).toBe(false);
    expect(await sessions.draft(token, draft, editorFrame())).toBe(true);

    // The same document asking (Chrome's documentId) doesn't count; another page doesn't match.
    expect(await sessions.recover(page.pageKey, contentScript())).toBeUndefined();
    expect(await sessions.recover('https://example.com/other', contentScript({ documentId: 'doc-2' }))).toBeUndefined();
    const recovered = await sessions.recover(page.pageKey, contentScript({ documentId: 'doc-2' }));
    expect(recovered).toEqual({ ...createRequest, draft });
    expect(await sessions.recover(page.pageKey, contentScript({ documentId: 'doc-3' }))).toBeUndefined();

    // Saved (or discarded) means there is nothing to recover.
    const saved = createEditorToken();
    await sessions.open(saved, editRequest, contentScript());
    await sessions.hello(saved, editorFrame());
    await sessions.draft(saved, draft, editorFrame());
    await sessions.settle(saved);
    expect(await sessions.recover(page.pageKey, contentScript({ documentId: 'doc-4' }))).toBeUndefined();
  });

  it('survive the background being stopped and started again (storage.session)', async () => {
    const token = createEditorToken();
    const before = new EditorSessions(fakeBrowser.storage.session, clock);
    await before.open(token, createRequest, contentScript());
    await before.hello(token, editorFrame());
    await before.draft(token, draft, editorFrame());
    // The screenshot is stored once, not with every draft update.
    const stored = await fakeBrowser.storage.session.get(null);
    expect(stored[`wm:editor-shot:${token}`]).toBe(createRequest.mode === 'create' && createRequest.screenshot);
    expect(JSON.stringify(stored[`wm:editor:${token}`])).not.toContain('base64');

    const after = new EditorSessions(fakeBrowser.storage.session, clock);
    expect(await after.frameTab(token, editorFrame())).toBe(TAB);
    expect(await after.hello(token, editorFrame())).toEqual({ ok: false });
    expect(await after.recover(page.pageKey, contentScript({ documentId: 'doc-2' }))).toEqual({ ...createRequest, draft });
    expect(await fakeBrowser.storage.session.get(null)).toEqual({});
  });
});

describe('background message handling', () => {
  it("relays the frame's events to the tab's top frame, and tells it when the frame connected", async () => {
    const sent: unknown[] = [];
    fakeBrowser.tabs.sendMessage = vi.fn(async (tabId: number, message: unknown, options?: { frameId?: number }) => {
      sent.push({ tabId, message, frameId: options?.frameId });
      return { ok: true };
    }) as unknown as typeof fakeBrowser.tabs.sendMessage;
    const sessions = new EditorSessions(fakeBrowser.storage.session, clock);
    const token = createEditorToken();

    expect(await handleEditorMessage(sessions, { type: 'wm:editor-open', token, request: createRequest }, contentScript())).toEqual({ ok: true });
    const hello = await handleEditorMessage(sessions, { type: 'wm:editor-hello', token }, editorFrame());
    expect(hello).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ tabId: TAB, frameId: 0, message: { type: 'wm:editor-event', token, event: { kind: 'connected' } } });

    const height = { type: 'wm:editor-emit', token, event: { kind: 'height', height: 312 } } as const;
    expect(await handleEditorMessage(sessions, height, editorFrame())).toEqual({ ok: true });
    expect(await handleEditorMessage(sessions, height, editorFrame({ frameId: 42 }))).toEqual({ ok: false });
    const malformed = { type: 'wm:editor-emit', token, event: { kind: 'height', height: -1 } } as const;
    expect(await handleEditorMessage(sessions, malformed, editorFrame())).toEqual({ ok: false });
    expect(sent).toHaveLength(2);

    // A save clears the draft before the page hears of it.
    await handleEditorMessage(sessions, { type: 'wm:editor-draft', token, draft }, editorFrame());
    const note = { id: 'n9', pageKey: page.pageKey, anchor: {} };
    await handleEditorMessage(sessions, { type: 'wm:editor-emit', token, event: { kind: 'saved', note } } as never, editorFrame());
    expect(await sessions.recover(page.pageKey, contentScript({ documentId: 'doc-2' }))).toBeUndefined();
  });
});

describe('validation', () => {
  it('accepts well-formed requests and frame events only', () => {
    expect(isEditorRequest(createRequest)).toBe(true);
    expect(isEditorRequest({ ...editRequest, draft })).toBe(true);
    expect(isEditorRequest({ ...editRequest, noteId: '' })).toBe(false);
    expect(isEditorRequest({ ...createRequest, anchor: 'div' })).toBe(false);
    expect(isEditorRequest({ ...createRequest, page: { ...page, pageKey: '' } })).toBe(false);
    expect(isEditorRequest({ ...editRequest, draft: { initial: draft.initial } })).toBe(false);

    // Drafts carry every status and priority, and nothing else.
    for (const status of ['open', 'in_progress', 'completed', 'archived'] as const) {
      expect(isEditorRequest({ ...editRequest, draft: { ...draft, values: { ...draft.values, status } } })).toBe(true);
    }
    for (const priority of ['low', 'medium', 'high'] as const) {
      expect(isEditorRequest({ ...editRequest, draft: { ...draft, values: { ...draft.values, priority } } })).toBe(true);
    }
    const withValues = (values: Record<string, unknown>) => ({ ...editRequest, draft: { ...draft, values: { ...draft.values, ...values } } });
    expect(isEditorRequest(withValues({ status: 'resolved' }))).toBe(false);
    expect(isEditorRequest(withValues({ status: 'done' }))).toBe(false);
    expect(isEditorRequest(withValues({ priority: 'urgent' }))).toBe(false);
    expect(isEditorRequest(withValues({ priority: undefined }))).toBe(false);

    expect(isEditorFrameEvent({ kind: 'dirty', dirty: true })).toBe(true);
    expect(isEditorFrameEvent({ kind: 'toast', text: 'Note saved', tone: 'info' })).toBe(true);
    expect(isEditorFrameEvent({ kind: 'toast', text: 'x'.repeat(500), tone: 'info' })).toBe(false);
    expect(isEditorFrameEvent({ kind: 'toast', text: 'x', tone: 'loud' })).toBe(false);
    expect(isEditorFrameEvent({ kind: 'height', height: Number.NaN })).toBe(false);
    expect(isEditorFrameEvent({ kind: 'connected' })).toBe(false);
    expect(isEditorFrameEvent({ kind: 'deleted' })).toBe(false);
  });
});
