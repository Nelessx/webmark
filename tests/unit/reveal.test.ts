import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { revealNote, revealNoteInBrowser } from '@/lib/compat';
import { saveNote, takePendingFocus } from '@/lib/storage';
import { NOTE_SCHEMA_VERSION, type ElementAnchor, type Note } from '@/lib/types';

/*
 * The dashboard's "Open on page": the background finds a tab showing the
 * note's page, or opens one. It used to reload the user's tab when that tab
 * had no WebMark content script; now it injects one.
 */

const PAGE = 'https://example.com/dashboard';
const REF = { pageKey: PAGE, noteId: 'n1' };

const note: Note = {
  id: 'n1',
  schemaVersion: NOTE_SCHEMA_VERSION,
  pageKey: PAGE,
  url: `${PAGE}?utm_source=mail`,
  pageTitle: 'Dashboard',
  label: 'Revenue card',
  body: 'Check the currency',
  status: 'open',
  tags: [],
  author: '',
  anchor: { selector: '#revenue' } as ElementAnchor,
  hasScreenshot: false,
  createdAt: 1,
  updatedAt: 1,
};

type SendMessage = (tabId: number, message: unknown, options?: unknown) => Promise<unknown>;

/** The content script in a tab: answers focus-note, or (undefined) there is none. */
function contentScriptAnswers(answer: unknown) {
  const tabs = fakeBrowser.tabs as unknown as { sendMessage: SendMessage };
  return vi.spyOn(tabs, 'sendMessage').mockImplementation(async () => {
    if (answer === undefined) throw new Error('Could not establish connection. Receiving end does not exist.');
    return answer;
  });
}

function spyReload() {
  return vi.spyOn(fakeBrowser.tabs as unknown as { reload: (tabId: number) => Promise<void> }, 'reload');
}

beforeEach(async () => {
  fakeBrowser.reset();
  await saveNote(note);
});

describe('revealNoteInBrowser', () => {
  it('switches to the tab showing the page and has its content script reveal the note', async () => {
    const tab = await fakeBrowser.tabs.create({ url: `${PAGE}#top` });
    const send = contentScriptAnswers({ found: true });
    const inject = vi.fn(async () => true);

    expect(await revealNoteInBrowser(REF, { injectContentScript: inject })).toBe(true);

    expect(send).toHaveBeenCalledWith(tab.id, { type: 'wm:focus-note', noteId: 'n1' }, { frameId: 0 });
    expect((await fakeBrowser.tabs.get(tab.id!)).active).toBe(true);
    expect(inject).not.toHaveBeenCalled();
    expect(await takePendingFocus(PAGE)).toBeUndefined();
  });

  it('injects WebMark into a tab that has no content script instead of reloading it', async () => {
    const tab = await fakeBrowser.tabs.create({ url: PAGE });
    contentScriptAnswers(undefined);
    const reload = spyReload();
    const inject = vi.fn(async () => true);

    expect(await revealNoteInBrowser(REF, { injectContentScript: inject })).toBe(true);

    expect(inject).toHaveBeenCalledWith(tab.id);
    expect(reload).not.toHaveBeenCalled();
    // The injected script reveals the note once it has loaded, like after opening the page.
    expect(await takePendingFocus(PAGE)).toBe('n1');
  });

  it('fails without leaving a pending note when WebMark cannot run in that tab', async () => {
    await fakeBrowser.tabs.create({ url: PAGE });
    contentScriptAnswers(undefined);
    const reload = spyReload();

    expect(await revealNoteInBrowser(REF, { injectContentScript: async () => false })).toBe(false);

    expect(reload).not.toHaveBeenCalled();
    expect(await takePendingFocus(PAGE)).toBeUndefined();
  });

  it('opens the page in a new tab only when no tab shows it', async () => {
    await fakeBrowser.tabs.create({ url: 'https://example.com/other' });
    contentScriptAnswers(undefined);
    const create = vi.spyOn(fakeBrowser.tabs, 'create');

    expect(await revealNoteInBrowser(REF, { windowId: 0, injectContentScript: async () => true })).toBe(true);

    expect(create).toHaveBeenCalledWith({ url: note.url, windowId: 0 });
    expect(await takePendingFocus(PAGE)).toBe('n1');
  });

  it('prefers a tab in the window the request came from', async () => {
    const otherWindow = (await fakeBrowser.windows.create({}))?.id;
    const elsewhere = await fakeBrowser.tabs.create({ url: PAGE });
    const here = await fakeBrowser.tabs.create({ url: PAGE, windowId: otherWindow });
    const send = contentScriptAnswers({ found: true });

    await revealNoteInBrowser(REF, { windowId: otherWindow, injectContentScript: async () => true });

    expect(send).toHaveBeenCalledWith(here.id, expect.anything(), expect.anything());
    expect(send).not.toHaveBeenCalledWith(elsewhere.id, expect.anything(), expect.anything());
  });

  it('never opens a saved address that is not a web or file page', async () => {
    const hostile = { ...note, id: 'bad', url: 'javascript:alert(1)' };
    await saveNote(hostile);
    const create = vi.spyOn(fakeBrowser.tabs, 'create');

    expect(await revealNoteInBrowser({ pageKey: PAGE, noteId: 'bad' }, { injectContentScript: async () => true })).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('fails for a note that no longer exists', async () => {
    expect(await revealNoteInBrowser({ pageKey: PAGE, noteId: 'gone' }, { injectContentScript: async () => true })).toBe(false);
  });
});

describe('revealNote (dashboard side)', () => {
  it('asks the background, and reports when it could not show the note', async () => {
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage');
    send.mockResolvedValueOnce({ ok: true } as never);
    await expect(revealNote(note)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith({ type: 'wm:reveal-note', pageKey: PAGE, noteId: 'n1' });

    send.mockResolvedValueOnce({ ok: false } as never);
    await expect(revealNote(note)).rejects.toThrow("Couldn't show the note");
  });
});
