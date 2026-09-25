import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { DraftState, EditorEvent, EditorRequest } from '@/lib/editor/protocol';
import type { PageState } from '@/lib/messages';
import { deleteNote, saveNote } from '@/lib/storage';
import { NOTE_SCHEMA_VERSION, type ElementAnchor, type Note } from '@/lib/types';
import { getPageKey } from '@/lib/url';

/*
 * The content script's side of the isolated editor, in jsdom: it registers a
 * session with the (fake) background, frames the editor page in the shadow
 * root, reacts to the frame's relayed events, and falls back to its in-page
 * editor when the frame doesn't connect.
 */

const picker = vi.hoisted(() => ({ options: null as null | { onPick(el: Element): void; onCancel(): void } }));

vi.mock('@/lib/anchor', async (importOriginal) => ({
  // The resolver's content-fingerprint helpers stay real.
  ...(await importOriginal<typeof import('@/lib/anchor')>()),
  createAnchor: (el: Element) => ({ selector: `#${el.id}` }),
  resolveAnchor: (anchor: ElementAnchor) => {
    const element = document.querySelector(anchor.selector);
    return element ? { element, confidence: 1, method: 'selector' } : null;
  },
  buildLabel: (el: Element) => `Label for ${el.id}`,
  describeElement: (el: Element) => el.tagName.toLowerCase(),
}));

vi.mock('@/lib/picker', () => ({
  startPicker: (options: { onPick(el: Element): void; onCancel(): void }) => {
    picker.options = options;
    return { stop: () => {}, active: true };
  },
}));

vi.mock('@/lib/format', () => ({
  formatRelativeTime: () => 'just now',
  noteToMarkdown: (n: Note) => n.body,
  parseTags: (input: string) => input.split(',').map((t) => t.trim()).filter(Boolean),
}));

interface EditorMessage {
  type: string;
  token?: string;
  request?: EditorRequest;
  draft?: DraftState | null;
}

/** Stands in for the background: records the editor messages the content script sends. */
const background = {
  messages: [] as EditorMessage[],
  openOk: true,
  recover: undefined as EditorRequest | undefined,
  /** What a broken frame had mirrored, handed back on wm:editor-fallback. */
  mirrored: undefined as DraftState | undefined,
};

function installBackground(): void {
  fakeBrowser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const m = message as EditorMessage;
    if (typeof m?.type !== 'string' || !m.type.startsWith('wm:editor-') || m.type === 'wm:editor-event') return false;
    background.messages.push(m);
    if (m.type === 'wm:editor-open') sendResponse({ ok: background.openOk });
    else if (m.type === 'wm:editor-recover') sendResponse({ request: background.recover });
    else if (m.type === 'wm:editor-fallback') sendResponse(background.mirrored ? { ok: true, draft: background.mirrored } : { ok: true });
    else sendResponse({ ok: true });
    return true;
  });
}

const pageKey = () => getPageKey(location.href);
const shadow = () => document.querySelector('webmark-ui')!.shadowRoot!;
const $ = (selector: string) => shadow().querySelector(selector);
const toasts = () => [...shadow().querySelectorAll('[data-wm-toast]')].map((t) => t.textContent);
const send = (message: unknown) => fakeBrowser.runtime.sendMessage(message);
/** What the background relays from the editor frame. */
const relay = (token: string, event: EditorEvent) => send({ type: 'wm:editor-event', token, event });

function makeNote(id: string, selector: string, createdAt: number): Note {
  return {
    id,
    schemaVersion: NOTE_SCHEMA_VERSION,
    pageKey: pageKey(),
    url: location.href,
    pageTitle: '',
    label: `Label ${id}`,
    body: `Body of ${id}`,
    status: 'open',
    priority: 'medium',
    tags: [],
    author: '',
    anchor: { selector } as ElementAnchor,
    hasScreenshot: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function stubRect(el: Element, rect: { top: number; left: number; width: number; height: number }): void {
  el.getBoundingClientRect = () =>
    ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height }) as DOMRect;
}

const sessionsOpened = () => background.messages.filter((m) => m.type === 'wm:editor-open');

/** The next session the content script registers (after the `before` it had already registered). */
async function opened(before: number): Promise<{ token: string; request: EditorRequest }> {
  return vi.waitFor(() => {
    const open = sessionsOpened()[before];
    if (!open?.token || !open.request) throw new Error('no session registered');
    return { token: open.token, request: open.request };
  });
}

function frame(): HTMLIFrameElement | null {
  return $('iframe[data-wm-editor-frame]') as HTMLIFrameElement | null;
}

let ctx: ContentScriptContext | null = null;

async function startContentScript(): Promise<void> {
  const { default: definition } = await import('@/entrypoints/content/index');
  ctx = new ContentScriptContext('content');
  await definition.main(ctx);
}

/** Pick #free; by default wait for the editor frame to be in the shadow root. */
async function pickFree(expectFrame = true): Promise<{ token: string; request: EditorRequest }> {
  const before = sessionsOpened().length;
  await send({ type: 'wm:start-picker' });
  picker.options?.onPick(document.getElementById('free')!);
  const session = await opened(before);
  if (expectFrame) await vi.waitFor(() => expect(frame()).not.toBeNull());
  return session;
}

const original = location.href;

beforeEach(() => {
  fakeBrowser.reset();
  installBackground();
  background.messages = [];
  background.openOk = true;
  background.recover = undefined;
  background.mirrored = undefined;
  picker.options = null;
  document.body.innerHTML = `
    <main>
      <div id="card-a">Revenue</div>
      <p id="free">Free text</p>
    </main>`;
  stubRect(document.getElementById('card-a')!, { top: 100, left: 100, width: 200, height: 80 });
  stubRect(document.getElementById('free')!, { top: 400, left: 100, width: 300, height: 20 });
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  ctx?.notifyInvalidated();
  ctx = null;
  document.querySelectorAll('webmark-ui').forEach((el) => el.remove());
  history.replaceState({}, '', original);
});

describe('isolated editor', () => {
  it('frames the editor page in the shadow root for a session registered with the page it belongs to', async () => {
    await startContentScript();
    const { token, request } = await pickFree();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(request).toMatchObject({
      mode: 'create',
      label: 'Label for free',
      anchor: { selector: '#free' },
      page: { pageKey: pageKey(), url: location.href, title: document.title },
    });

    const iframe = await vi.waitFor(() => frame() ?? Promise.reject(new Error('no frame')));
    expect(iframe.getAttribute('src')).toBe(`chrome-extension://test-extension-id/note-editor.html#${token}`);
    // No form in the page, nor the token.
    expect($('[data-wm-editor]')).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain(token);
    // Hidden until the frame has connected and reported its size.
    const wrapper = iframe.parentElement!;
    expect(wrapper.style.visibility).toBe('hidden');
    await relay(token, { kind: 'connected' });
    await relay(token, { kind: 'height', height: 300 });
    await vi.waitFor(() => expect(wrapper.style.visibility).toBe('visible'));
    expect(iframe.style.clipPath).toMatch(/^inset\(0(px)? 0(px)? \d+px 0(px)? round 14px\)$/);

    // With changes in the frame, another note can't start.
    await relay(token, { kind: 'dirty', dirty: true });
    expect(await send({ type: 'wm:start-picker' })).toEqual({ ok: false });
    expect(toasts()).toContain('Save or discard the open note first');
    // Events of any other session change nothing.
    expect(await relay('0'.repeat(32), { kind: 'closed' })).toEqual({ ok: false });
    expect(frame()).not.toBeNull();

    // Saved by the frame: the editor goes, the pin shows on the element, the session ends.
    const note = makeNote('new-1', '#free', 5);
    await saveNote(note);
    expect(await relay(token, { kind: 'saved', note })).toEqual({ ok: true });
    await vi.waitFor(() => expect(frame()).toBeNull());
    await vi.waitFor(() => expect($('[data-wm-pin="new-1"]')?.textContent).toBe('1'));
    expect(toasts()).toContain('Note saved');
    expect(background.messages).toContainEqual({ type: 'wm:editor-close', token });
  });

  it('closes on Cancel in the frame and shows its toasts', async () => {
    await startContentScript();
    const { token } = await pickFree();
    await relay(token, { kind: 'toast', text: 'Copied to clipboard', tone: 'info' });
    expect(toasts()).toContain('Copied to clipboard');
    await relay(token, { kind: 'closed' });
    await vi.waitFor(() => expect(frame()).toBeNull());
  });

  it('falls back to the in-page editor, with a warning, when the frame never says hello', async () => {
    await startContentScript();
    const { token } = await pickFree();
    await vi.waitFor(() => expect($('[data-wm-editor="create"]')).not.toBeNull(), { timeout: 3000 });
    expect(frame()).toBeNull();
    expect($('[data-wm-insecure]')?.textContent).toBe('Typing here is visible to this page.');
    expect(background.messages).toContainEqual({ type: 'wm:editor-fallback', token });
    // A late hello's events are ignored.
    expect(await relay(token, { kind: 'closed' })).toEqual({ ok: false });

    // The fallback's unsaved values go to the background, for recovery after a reload.
    const textarea = $('[data-wm-body]') as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Typed in the page');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() =>
      expect(background.messages.filter((m) => m.type === 'wm:editor-draft').at(-1)).toMatchObject({
        token,
        draft: { values: { body: 'Typed in the page' } },
      }),
    );
  });

  it('replaces a frame that loaded again (the page re-inserted our host) with a new one, keeping what was typed', async () => {
    await startContentScript();
    const first = await pickFree();
    await relay(first.token, { kind: 'connected' });
    background.mirrored = {
      initial: { label: 'Label for free', body: '', tags: '', status: 'open', priority: 'medium' },
      values: { label: 'Label for free', body: 'Typed before the reload', tags: '', status: 'open', priority: 'high' },
    };
    const iframe = frame()!;
    iframe.dispatchEvent(new Event('load'));
    iframe.dispatchEvent(new Event('load'));

    const second = await opened(1);
    expect(second.token).not.toBe(first.token);
    expect(second.request).toMatchObject({ mode: 'create', draft: background.mirrored });
    await vi.waitFor(() => expect(frame()?.getAttribute('src')).toContain(second.token));
    expect(background.messages).toContainEqual({ type: 'wm:editor-fallback', token: first.token });
    expect(background.messages).toContainEqual({ type: 'wm:editor-close', token: first.token });
    // It carries the typed changes: a page click leaves it open.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    expect(frame()).not.toBeNull();
  });

  it('uses the in-page editor right away when the background has no session for it', async () => {
    background.openOk = false;
    await startContentScript();
    await pickFree(false);
    await vi.waitFor(() => expect($('[data-wm-editor="create"]')).not.toBeNull());
    expect(frame()).toBeNull();
  });

  it("deleting from the frame isn't reported as a deletion elsewhere; a deletion elsewhere closes it", async () => {
    await saveNote(makeNote('n1', '#card-a', 1));
    await saveNote(makeNote('n2', '#free', 2));
    await startContentScript();

    expect(await send({ type: 'wm:focus-note', noteId: 'n1' })).toEqual({ found: true });
    const first = await opened(0);
    await vi.waitFor(() => expect(frame()).not.toBeNull());
    expect(first.request).toMatchObject({ mode: 'edit', noteId: 'n1', label: 'Label n1', page: { pageKey: pageKey() } });
    await relay(first.token, { kind: 'deleting' });
    await deleteNote(pageKey(), 'n1');
    await vi.waitFor(() => expect($('[data-wm-pin="n1"]')).toBeNull());
    expect(frame()).not.toBeNull();
    await relay(first.token, { kind: 'deleted', noteId: 'n1' });
    await vi.waitFor(() => expect(frame()).toBeNull());
    expect(toasts()).toContain('Note deleted');
    expect(toasts()).not.toContain('This note was deleted');

    expect(await send({ type: 'wm:focus-note', noteId: 'n2' })).toEqual({ found: true });
    await opened(1);
    await vi.waitFor(() => expect(frame()).not.toBeNull());
    await deleteNote(pageKey(), 'n2');
    await vi.waitFor(() => expect(frame()).toBeNull());
    expect(toasts()).toContain('This note was deleted');
  });

  it('SPA navigation closes an untouched editor, and keeps one with changes for the page it was opened on', async () => {
    await startContentScript();
    const untouched = await pickFree();
    history.pushState({}, '', '/elsewhere');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.waitFor(() => expect(frame()).toBeNull());
    expect(background.messages).toContainEqual({ type: 'wm:editor-close', token: untouched.token });

    history.pushState({}, '', original);
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.waitFor(async () => expect(((await send({ type: 'wm:get-page-state' })) as PageState).pageKey).toBe(getPageKey(original)));
    const kept = await pickFree();
    await relay(kept.token, { kind: 'dirty', dirty: true });
    history.pushState({}, '', '/next-route');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.waitFor(async () => expect(((await send({ type: 'wm:get-page-state' })) as PageState).pageKey).toBe(pageKey()));
    expect(frame()).not.toBeNull();
    expect(kept.request.page).toMatchObject({ pageKey: getPageKey(original), url: original });
  });

  it('reopens a draft the tab left unsaved, still with its changes', async () => {
    const draft: DraftState = {
      initial: { label: 'Label for free', body: '', tags: '', status: 'open', priority: 'medium' },
      values: { label: 'Label for free', body: 'Half a thought', tags: '', status: 'open', priority: 'low' },
    };
    background.recover = {
      mode: 'create',
      page: { pageKey: pageKey(), url: location.href, title: '' },
      label: 'Label for free',
      anchor: { selector: '#free' } as ElementAnchor,
      draft,
    };
    await startContentScript();

    const { request } = await opened(0);
    expect(request).toMatchObject({ mode: 'create', draft });
    await vi.waitFor(() => expect(frame()).not.toBeNull());
    expect(background.messages).toContainEqual({ type: 'wm:editor-recover', pageKey: pageKey() });
    await vi.waitFor(() => expect(toasts()).toContain('Restored an unsaved note'));
    // It has changes: a click on the page leaves it open.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    expect(frame()).not.toBeNull();
  });
});
