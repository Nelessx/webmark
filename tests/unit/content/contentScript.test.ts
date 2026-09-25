import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { ContentMessage, PageState } from '@/lib/messages';
import { deleteNote, getNotesForPage, getScreenshot, getSettings, saveNote, updateNote } from '@/lib/storage';
import { NOTE_SCHEMA_VERSION, type ElementAnchor, type Note } from '@/lib/types';
import { getPageKey } from '@/lib/url';

/*
 * Runs the real content script (entrypoints/content) in jsdom against WXT's
 * fake browser. Anchoring, the picker and formatting are owned by other
 * modules, so they're replaced by simple stand-ins: an anchor's selector is
 * its identity.
 */

const picker = vi.hoisted(() => ({
  options: null as null | { onPick(el: Element): void; onCancel(): void },
  stop: vi.fn(),
}));

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
    return { stop: picker.stop, active: true };
  },
}));

vi.mock('@/lib/format', () => ({
  formatRelativeTime: () => 'just now',
  noteToMarkdown: (n: Note) => `**${n.label}**\n\n${n.body}`,
  parseTags: (input: string) => input.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
}));

const pageKey = () => getPageKey(location.href);

function makeNote(
  id: string,
  selector: string,
  createdAt: number,
  status: Note['status'] = 'open',
  priority: Note['priority'] = 'medium',
): Note {
  return {
    id,
    schemaVersion: NOTE_SCHEMA_VERSION,
    pageKey: pageKey(),
    url: location.href,
    pageTitle: '',
    label: `Label ${id}`,
    body: `Body of ${id}`,
    status,
    priority,
    tags: [],
    author: '',
    anchor: { selector } as ElementAnchor,
    hasScreenshot: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function send<M extends ContentMessage>(message: M): Promise<unknown> {
  return fakeBrowser.runtime.sendMessage(message);
}

function shadow(): ShadowRoot {
  const host = document.querySelector('webmark-ui');
  if (!host?.shadowRoot) throw new Error('WebMark host not mounted');
  return host.shadowRoot;
}

const $ = (selector: string) => shadow().querySelector(selector);
const $$ = (selector: string) => [...shadow().querySelectorAll(selector)];

function stubRect(el: Element, rect: { top: number; left: number; width: number; height: number }): void {
  el.getBoundingClientRect = () =>
    ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height }) as DOMRect;
}

function textareaKey(key: string, init: KeyboardEventInit = {}): void {
  const textarea = $('[data-wm-editor] textarea') as HTMLTextAreaElement;
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

/** Type into a React-controlled field the way a user would. */
function typeInto(field: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

let ctx: ContentScriptContext | null = null;

async function startContentScript(): Promise<void> {
  const { default: definition } = await import('@/entrypoints/content/index');
  ctx = new ContentScriptContext('content');
  await definition.main(ctx);
}

beforeEach(() => {
  fakeBrowser.reset();
  picker.options = null;
  picker.stop.mockClear();
  document.body.innerHTML = `
    <main>
      <div id="card-a">Revenue</div>
      <button id="btn-b">Buy</button>
      <p id="free">Free text</p>
    </main>`;
  stubRect(document.getElementById('card-a')!, { top: 100, left: 100, width: 200, height: 80 });
  stubRect(document.getElementById('btn-b')!, { top: 300, left: 100, width: 120, height: 40 });
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
});

describe('content script', () => {
  it('mounts one host and replaces UI left by a stale instance', async () => {
    const stale = document.createElement('webmark-ui');
    document.body.append(stale);
    await startContentScript();
    const hosts = document.querySelectorAll('webmark-ui');
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).not.toBe(stale);
    expect($('[data-wm-picker-layer]')).not.toBeNull();
  });

  it('does nothing when a live instance already runs in this world', async () => {
    await startContentScript();
    const host = document.querySelector('webmark-ui');
    const { default: definition } = await import('@/entrypoints/content/index');
    // A differently named context isn't invalidated by WXT, so the first instance stays live.
    const second = new ContentScriptContext('content-reinjected');
    await definition.main(second);
    expect(document.querySelectorAll('webmark-ui')).toHaveLength(1);
    expect(document.querySelector('webmark-ui')).toBe(host);
    second.notifyInvalidated();
  });

  it('captures a screenshot with the UI hidden and stores it with the note', async () => {
    const shot = 'data:image/jpeg;base64,AAAA';
    let hiddenDuringCapture = false;
    fakeBrowser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if ((message as { type?: string }).type !== 'wm:capture-element') return false;
      hiddenDuringCapture = document.querySelector('webmark-ui')!.hasAttribute('data-wm-hidden');
      sendResponse({ dataUrl: shot });
      return true;
    });
    await startContentScript();
    await send({ type: 'wm:start-picker' });
    picker.options?.onPick(document.getElementById('card-a')!);

    await vi.waitFor(() => expect($('[data-wm-shot]')).not.toBeNull());
    expect(hiddenDuringCapture).toBe(true);
    expect(document.querySelector('webmark-ui')!.hasAttribute('data-wm-hidden')).toBe(false);

    typeInto($('[data-wm-editor] textarea') as HTMLTextAreaElement, 'Monthly revenue please');
    textareaKey('Enter', { ctrlKey: true });
    await vi.waitFor(async () => expect(await getNotesForPage(pageKey())).toHaveLength(1));
    const [saved] = await getNotesForPage(pageKey());
    expect(saved?.hasScreenshot).toBe(true);
    expect(await getScreenshot(saved!.id)).toBe(shot);
  });

  it('shows numbered pins for found notes and reports page state', async () => {
    await saveNote(makeNote('n1', '#card-a', 1));
    await saveNote(makeNote('n2', '#btn-b', 2, 'completed'));
    await saveNote(makeNote('n3', '#gone', 3));
    await startContentScript();

    await vi.waitFor(() => expect($$('[data-wm-pin]')).toHaveLength(2));
    const pin1 = $('[data-wm-pin="n1"]');
    const pin2 = $('[data-wm-pin="n2"]');
    expect(pin1?.textContent).toBe('1');
    expect(pin2?.textContent).toBe('2');
    expect(pin1?.getAttribute('data-status')).toBe('open');
    expect(pin2?.getAttribute('data-status')).toBe('completed');

    const state = (await send({ type: 'wm:get-page-state' })) as PageState;
    expect(state.resolvedIds.sort()).toEqual(['n1', 'n2']);
    expect(state.orphanedIds).toEqual(['n3']);
    expect(state.activeCount).toBe(2);
    expect(state.statusCounts).toEqual({ open: 2, in_progress: 0, completed: 1, archived: 0 });
    expect(state.pinsVisible).toBe(true);
  });

  it('gives archived notes no pin while numbers stay put, and never reports them as not found', async () => {
    await saveNote(makeNote('n1', '#card-a', 1));
    await saveNote(makeNote('n2', '#btn-b', 2, 'archived'));
    await saveNote(makeNote('n3', '#free', 3, 'in_progress'));
    await saveNote(makeNote('n4', '#gone', 4, 'archived'));
    await startContentScript();

    await vi.waitFor(() => expect($$('[data-wm-pin]')).toHaveLength(2));
    expect($('[data-wm-pin="n2"]')).toBeNull();
    // "#3" is the third note of the page, archived ones included, everywhere.
    expect($('[data-wm-pin="n1"]')?.textContent).toBe('1');
    expect($('[data-wm-pin="n3"]')?.textContent).toBe('3');
    expect($('[data-wm-pin="n3"]')?.getAttribute('data-status')).toBe('in_progress');

    const state = (await send({ type: 'wm:get-page-state' })) as PageState;
    expect(state.resolvedIds.sort()).toEqual(['n1', 'n2', 'n3']);
    expect(state.orphanedIds).toEqual([]);
    expect(state.activeCount).toBe(2);
    expect(state.statusCounts).toEqual({ open: 1, in_progress: 1, completed: 0, archived: 2 });

    // An archived note whose element is gone gets no "not found" card either.
    expect(await send({ type: 'wm:focus-note', noteId: 'n4' })).toEqual({ found: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect($('[data-wm-orphan-card]')).toBeNull();

    // One that is found still opens (from the side panel, say), to be edited or unarchived.
    expect(await send({ type: 'wm:focus-note', noteId: 'n2' })).toEqual({ found: true });
    await vi.waitFor(() => expect($('[data-wm-editor="edit"]')?.getAttribute('data-wm-note-id')).toBe('n2'));
    expect($('[data-wm-status]')?.getAttribute('data-wm-status')).toBe('archived');
  });

  it('marks a high-priority pin and shows status and priority when a pin is hovered', async () => {
    await saveNote(makeNote('n1', '#card-a', 1, 'in_progress', 'high'));
    await saveNote(makeNote('n2', '#btn-b', 2, 'open', 'low'));
    await startContentScript();
    await vi.waitFor(() => expect($$('[data-wm-pin]')).toHaveLength(2));

    const high = $('[data-wm-pin="n1"]') as HTMLButtonElement;
    expect(high.getAttribute('data-priority')).toBe('high');
    expect(high.getAttribute('aria-label')).toBe('WebMark note 1, In progress, high priority: Label n1');
    expect($('[data-wm-pin="n2"]')?.getAttribute('data-priority')).toBe('low');
    expect($('[data-wm-pin="n2"]')?.getAttribute('aria-label')).toBe('WebMark note 2, Open: Label n2');

    high.focus();
    await vi.waitFor(() => expect($('[data-wm-tooltip="n1"]')).not.toBeNull());
    const tooltip = $('[data-wm-tooltip="n1"]')!;
    expect(tooltip.querySelector('.wm-tooltip__num')?.getAttribute('data-status')).toBe('in_progress');
    expect(tooltip.querySelector('.wm-tooltip__status')?.textContent).toBe('In progress');
    expect(tooltip.querySelector('.wm-tooltip__priority')?.textContent).toBe('High priority');
  });

  it('removes the pin and the "not found" card of a note archived elsewhere', async () => {
    await saveNote(makeNote('n1', '#card-a', 1));
    await saveNote(makeNote('n2', '#gone', 2));
    await startContentScript();
    await vi.waitFor(() => expect($$('[data-wm-pin]')).toHaveLength(1));
    expect(await send({ type: 'wm:focus-note', noteId: 'n2' })).toEqual({ found: false });
    await vi.waitFor(() => expect($('[data-wm-orphan-card="n2"]')).not.toBeNull());

    await updateNote(pageKey(), 'n2', { status: 'archived' });
    await vi.waitFor(() => expect($('[data-wm-orphan-card]')).toBeNull());
    await updateNote(pageKey(), 'n1', { status: 'archived' });
    await vi.waitFor(() => expect($$('[data-wm-pin]')).toHaveLength(0));
    expect(((await send({ type: 'wm:get-page-state' })) as PageState).orphanedIds).toEqual([]);

    // Unarchived, it is back where it was.
    await updateNote(pageKey(), 'n1', { status: 'open' });
    await vi.waitFor(() => expect($('[data-wm-pin="n1"]')?.textContent).toBe('1'));
  });

  it('creates a note from the picker and saves it to storage', async () => {
    await startContentScript();
    expect(await send({ type: 'wm:start-picker' })).toEqual({ ok: true });
    expect(((await send({ type: 'wm:get-page-state' })) as PageState).pickerActive).toBe(true);

    picker.options?.onPick(document.getElementById('free')!);
    await vi.waitFor(() => expect($('[data-wm-editor="create"]')).not.toBeNull());

    const save = $('[data-wm-save]') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(($('[data-wm-label]') as HTMLInputElement).value).toBe('Label for free');

    // A new note starts open: no status choice, and priority Medium until changed.
    expect($('[data-wm-status]')).toBeNull();
    expect($('[data-wm-priority]')?.getAttribute('data-wm-priority')).toBe('medium');
    expect($('[data-wm-priority-option="medium"]')?.getAttribute('aria-checked')).toBe('true');

    typeInto($('[data-wm-editor] textarea') as HTMLTextAreaElement, 'Make this bold');
    typeInto($('[data-wm-tags]') as HTMLInputElement, 'Copy, UI');
    ($('[data-wm-priority-option="high"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect($('[data-wm-priority-option="high"]')?.getAttribute('aria-checked')).toBe('true'));
    await vi.waitFor(() => expect(save.disabled).toBe(false));
    save.click();

    await vi.waitFor(async () => expect(await getNotesForPage(pageKey())).toHaveLength(1));
    const [saved] = await getNotesForPage(pageKey());
    expect(saved).toMatchObject({
      body: 'Make this bold',
      label: 'Label for free',
      tags: ['copy', 'ui'],
      status: 'open',
      priority: 'high',
      anchor: { selector: '#free' },
      hasScreenshot: false,
    });
    await vi.waitFor(() => expect($('[data-wm-editor]')).toBeNull());
    await vi.waitFor(() => expect($(`[data-wm-pin="${saved!.id}"]`)?.textContent).toBe('1'));
    expect($$('[data-wm-toast]').map((t) => t.textContent)).toContain('Note saved');
  });

  it('asks before discarding a draft with Escape', async () => {
    await startContentScript();
    await send({ type: 'wm:start-picker' });
    picker.options?.onPick(document.getElementById('free')!);
    await vi.waitFor(() => expect($('[data-wm-editor]')).not.toBeNull());

    typeInto($('[data-wm-editor] textarea') as HTMLTextAreaElement, 'draft');
    textareaKey('Escape');
    await vi.waitFor(() => expect($('[data-wm-confirm="discard"]')).not.toBeNull());

    // A draft blocks starting another note.
    expect(await send({ type: 'wm:start-picker' })).toEqual({ ok: false });

    ($('[data-wm-discard]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect($('[data-wm-editor]')).toBeNull());
    expect(await getNotesForPage(pageKey())).toHaveLength(0);
  });

  it('focuses a found note in edit mode and saves a status change', async () => {
    await saveNote(makeNote('n1', '#card-a', 1));
    await startContentScript();

    expect(await send({ type: 'wm:focus-note', noteId: 'n1' })).toEqual({ found: true });
    expect(document.getElementById('card-a')!.scrollIntoView).toHaveBeenCalled();
    await vi.waitFor(() => expect($('[data-wm-editor="edit"]')).not.toBeNull());
    expect($('[data-wm-outline="flash"]')).not.toBeNull();
    expect(($('[data-wm-editor] textarea') as HTMLTextAreaElement).value).toBe('Body of n1');
    // All four statuses, the note's own chosen.
    expect($$('[data-wm-status-option]').map((o) => [o.textContent, o.getAttribute('aria-checked')])).toEqual([
      ['Open', 'true'],
      ['In progress', 'false'],
      ['Completed', 'false'],
      ['Archived', 'false'],
    ]);

    ($('[data-wm-status-option="completed"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(($('[data-wm-save]') as HTMLButtonElement).disabled).toBe(false));
    ($('[data-wm-save]') as HTMLButtonElement).click();
    await vi.waitFor(async () => expect((await getNotesForPage(pageKey()))[0]?.status).toBe('completed'));
    expect((await getNotesForPage(pageKey()))[0]?.priority).toBe('medium');
  });

  it('moves the status and priority with the arrow keys', async () => {
    await saveNote(makeNote('n1', '#card-a', 1));
    await startContentScript();
    expect(await send({ type: 'wm:focus-note', noteId: 'n1' })).toEqual({ found: true });
    await vi.waitFor(() => expect($('[data-wm-editor="edit"]')).not.toBeNull());

    // One tab stop per group: the chosen option.
    expect($$('[data-wm-status-option]').map((o) => o.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
    const status = $('[data-wm-status]') as HTMLElement;
    status.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await vi.waitFor(() => expect(status.getAttribute('data-wm-status')).toBe('in_progress'));
    expect(shadow().activeElement?.getAttribute('data-wm-status-option')).toBe('in_progress');
    status.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await vi.waitFor(() => expect(status.getAttribute('data-wm-status')).toBe('archived'));

    const priority = $('[data-wm-priority]') as HTMLElement;
    priority.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await vi.waitFor(() => expect(priority.getAttribute('data-wm-priority')).toBe('low'));

    ($('[data-wm-save]') as HTMLButtonElement).click();
    await vi.waitFor(async () =>
      expect(await getNotesForPage(pageKey())).toMatchObject([{ status: 'archived', priority: 'low' }]),
    );
  });

  it('saving an edit keeps changes made elsewhere while the editor was open', async () => {
    await saveNote({ ...makeNote('n1', '#card-a', 1), tags: ['data'] });
    await startContentScript();
    expect(await send({ type: 'wm:focus-note', noteId: 'n1' })).toEqual({ found: true });
    await vi.waitFor(() => expect($('[data-wm-editor="edit"]')).not.toBeNull());

    // Meanwhile the dashboard completes, re-prioritises and re-tags the note.
    await updateNote(pageKey(), 'n1', { status: 'completed', priority: 'high', tags: ['data', 'ux'] });
    await vi.waitFor(() => expect($('[data-wm-editor="edit"]')).not.toBeNull());

    // Only the text is edited here.
    typeInto($('[data-wm-editor] textarea') as HTMLTextAreaElement, 'Edited in the page');
    ($('[data-wm-save]') as HTMLButtonElement).click();
    await vi.waitFor(async () => expect((await getNotesForPage(pageKey()))[0]?.body).toBe('Edited in the page'));
    expect((await getNotesForPage(pageKey()))[0]).toMatchObject({
      label: 'Label n1',
      status: 'completed',
      priority: 'high',
      tags: ['data', 'ux'],
    });
  });

  it('an edited priority is saved without the status the editor opened with', async () => {
    await saveNote(makeNote('n1', '#card-a', 1));
    await startContentScript();
    expect(await send({ type: 'wm:focus-note', noteId: 'n1' })).toEqual({ found: true });
    await vi.waitFor(() => expect($('[data-wm-editor="edit"]')).not.toBeNull());

    await updateNote(pageKey(), 'n1', { status: 'in_progress' });
    ($('[data-wm-priority-option="high"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(($('[data-wm-save]') as HTMLButtonElement).disabled).toBe(false));
    ($('[data-wm-save]') as HTMLButtonElement).click();
    await vi.waitFor(async () => expect((await getNotesForPage(pageKey()))[0]?.priority).toBe('high'));
    expect((await getNotesForPage(pageKey()))[0]).toMatchObject({ status: 'in_progress', body: 'Body of n1' });
  });

  it('shows an orphaned note in the floating card', async () => {
    await saveNote(makeNote('n1', '#gone', 1));
    await startContentScript();

    expect(await send({ type: 'wm:focus-note', noteId: 'n1' })).toEqual({ found: false });
    await vi.waitFor(() => expect($('[data-wm-orphan-card="n1"]')).not.toBeNull());
    expect($('[data-wm-orphan-card]')?.textContent).toContain("The element for this note isn't on the page right now.");
    expect($('[data-wm-orphan-card] .wm-card__status')?.textContent).toBe('Open');
    expect($('[data-wm-orphan-card] .wm-card__priority')?.textContent).toBe('Medium priority');
    expect(await send({ type: 'wm:focus-note', noteId: 'unknown' })).toEqual({ found: false });
  });

  it('reacts to notes deleted elsewhere and to pin visibility changes', async () => {
    await saveNote(makeNote('n1', '#card-a', 1));
    await saveNote(makeNote('n2', '#btn-b', 2));
    await startContentScript();
    await vi.waitFor(() => expect($$('[data-wm-pin]')).toHaveLength(2));

    await deleteNote(pageKey(), 'n1');
    await vi.waitFor(() => expect($$('[data-wm-pin]')).toHaveLength(1));
    expect($('[data-wm-pin="n2"]')?.textContent).toBe('1');

    expect(await send({ type: 'wm:set-pins-visible' })).toEqual({ ok: true });
    expect((await getSettings()).pinsVisible).toBe(false);
    await vi.waitFor(() => expect($$('[data-wm-pin]')).toHaveLength(0));

    expect(await send({ type: 'wm:set-pins-visible', visible: true })).toEqual({ ok: true });
    await vi.waitFor(() => expect($$('[data-wm-pin]')).toHaveLength(1));
  });

  it('ignores a right-click the page dispatched itself: the menu item starts the picker', async () => {
    await startContentScript();
    // jsdom events are untrusted, like a page's own dispatchEvent(). A real
    // right-click opens the editor (tests/unit/context-menu.test.ts, e2e).
    const target = document.getElementById('btn-b')!;
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true }));
    expect(await send({ type: 'wm:note-from-context-menu' })).toEqual({ ok: true });
    expect(picker.options).not.toBeNull();
    expect($('[data-wm-editor]')).toBeNull();
  });

  it('re-resolves notes when the DOM changes', async () => {
    await saveNote(makeNote('late', '#late', 1));
    await saveNote(makeNote('a', '#card-a', 2));
    await startContentScript();
    await vi.waitFor(() => expect($$('[data-wm-pin]')).toHaveLength(1));
    expect(((await send({ type: 'wm:get-page-state' })) as PageState).orphanedIds).toEqual(['late']);

    // An element rendered later (lazy SPA content) gets its pin.
    const late = document.createElement('section');
    late.id = 'late';
    stubRect(late, { top: 500, left: 50, width: 100, height: 100 });
    document.body.append(late);
    await vi.waitFor(() => expect($('[data-wm-pin="late"]')).not.toBeNull(), { timeout: 3000 });

    // A re-render that replaces the element moves the pin to the new one.
    const old = document.getElementById('card-a')!;
    const replacement = old.cloneNode(true) as HTMLElement;
    stubRect(replacement, { top: 600, left: 400, width: 100, height: 40 });
    old.replaceWith(replacement);
    await vi.waitFor(
      () => expect(($('[data-wm-pin="a"]') as HTMLElement | null)?.style.translate).toBe(`${500 - 12}px ${600 - 12}px`),
      { timeout: 3000 },
    );
    const state = (await send({ type: 'wm:get-page-state' })) as PageState;
    expect(state.orphanedIds).toEqual([]);
    expect(state.resolvedIds.sort()).toEqual(['a', 'late']);
  });

  it('reloads notes after SPA navigation', async () => {
    await saveNote(makeNote('n1', '#card-a', 1));
    await startContentScript();
    await vi.waitFor(() => expect($$('[data-wm-pin]')).toHaveLength(1));

    const original = location.href;
    history.pushState({}, '', '/other-page');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.waitFor(() => expect($$('[data-wm-pin]')).toHaveLength(0));
    const state = (await send({ type: 'wm:get-page-state' })) as PageState;
    expect(state.pageKey).toBe(getPageKey(location.href));
    history.pushState({}, '', original);
  });
});
