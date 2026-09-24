import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { PageState } from '@/lib/messages';
import { getNotesForPage, saveSettings } from '@/lib/storage';
import { getPageKey } from '@/lib/url';

/*
 * Smoke test with the real anchor and format modules (only the picker, which
 * needs real pointer input, is replaced): a note created on an element is
 * found again by a fresh content script instance.
 */

const picker = vi.hoisted(() => ({ onPick: null as null | ((el: Element) => void) }));

vi.mock('@/lib/picker', () => ({
  startPicker: (options: { onPick(el: Element): void }) => {
    picker.onPick = options.onPick;
    return { stop: () => {}, active: true };
  },
}));

let ctx: ContentScriptContext | null = null;

async function start(): Promise<void> {
  const { default: definition } = await import('@/entrypoints/content/index');
  ctx = new ContentScriptContext('content');
  await definition.main(ctx);
}

function stop(): void {
  ctx?.notifyInvalidated();
  ctx = null;
}

const shadow = () => document.querySelector('webmark-ui')!.shadowRoot!;

beforeEach(() => {
  fakeBrowser.reset();
  document.body.innerHTML = `
    <header><h1>Dashboard</h1></header>
    <main>
      <section class="card" data-testid="revenue-card" aria-label="Revenue">
        <h2>Revenue</h2><p>$12,400</p>
      </section>
    </main>`;
  const card = document.querySelector('[data-testid="revenue-card"]')!;
  card.getBoundingClientRect = () => ({ top: 100, left: 100, width: 300, height: 120, right: 400, bottom: 220, x: 100, y: 100 }) as DOMRect;
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  stop();
  document.querySelectorAll('webmark-ui').forEach((el) => el.remove());
});

it('creates a note with a real anchor and finds the element again after a reload', async () => {
  await saveSettings({ captureScreenshots: false, authorName: 'Dana' });
  await start();
  await fakeBrowser.runtime.sendMessage({ type: 'wm:start-picker' });
  picker.onPick?.(document.querySelector('[data-testid="revenue-card"]')!);

  await vi.waitFor(() => expect(shadow().querySelector('[data-wm-editor="create"]')).not.toBeNull());
  const label = (shadow().querySelector('[data-wm-label]') as HTMLInputElement).value;
  expect(label.length).toBeGreaterThan(0);

  const textarea = shadow().querySelector('[data-wm-body]') as HTMLTextAreaElement;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Change this to monthly revenue');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect((shadow().querySelector('[data-wm-save]') as HTMLButtonElement).disabled).toBe(false));
  (shadow().querySelector('[data-wm-save]') as HTMLButtonElement).click();

  const pageKey = getPageKey(location.href);
  await vi.waitFor(async () => expect(await getNotesForPage(pageKey)).toHaveLength(1));
  const [note] = await getNotesForPage(pageKey);
  expect(note).toMatchObject({ label, author: 'Dana', body: 'Change this to monthly revenue' });
  expect(note?.anchor.tagName).toBe('section');

  // "Reload": a fresh instance resolves the stored anchor on its own.
  stop();
  document.querySelectorAll('webmark-ui').forEach((el) => el.remove());
  await start();
  await vi.waitFor(() => expect(shadow().querySelector(`[data-wm-pin="${note!.id}"]`)?.textContent).toBe('1'));
  const state = (await fakeBrowser.runtime.sendMessage({ type: 'wm:get-page-state' })) as PageState;
  expect(state.resolvedIds).toEqual([note!.id]);
  expect(state.orphanedIds).toEqual([]);
});
