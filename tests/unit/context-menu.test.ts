import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_MENU_TARGET_TTL_MS, ContextMenuTracker } from '@/entrypoints/content/contextMenu';
import { addNoteMenuMessage } from '@/lib/menus';

/*
 * "Add WebMark note to this element": the content script remembers the
 * right-clicked element, and the background decides what the menu item asks
 * of the page.
 */

type Handler = (event: Event) => void;

/**
 * A tracker whose listeners the test calls directly: jsdom can only dispatch
 * untrusted events, and the tracker must tell real input from a page's
 * dispatchEvent().
 */
function track() {
  const handlers = new Map<string, Handler>();
  const ctx = {
    addEventListener: (_target: EventTarget, type: string, handler: Handler) => void handlers.set(type, handler),
  };
  const tracker = new ContextMenuTracker(ctx as unknown as ConstructorParameters<typeof ContextMenuTracker>[0]);
  const fire = (type: 'contextmenu' | 'pointerdown', target: Node, isTrusted = true) =>
    handlers.get(type)?.({ type, isTrusted, composedPath: () => [target] } as unknown as Event);
  return { tracker, fire };
}

let card: HTMLElement;
let button: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<main><div id="card">Revenue <button id="btn">Details</button></div></main>';
  card = document.getElementById('card')!;
  button = document.getElementById('btn')!;
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ContextMenuTracker', () => {
  it('remembers the element of the right-click that opened the menu, once', () => {
    const { tracker, fire } = track();
    fire('pointerdown', button);
    fire('contextmenu', button);
    expect(tracker.take()).toBe(button);
    expect(tracker.take()).toBeNull();
  });

  it('uses the element for a text node that was right-clicked', () => {
    const { tracker, fire } = track();
    fire('contextmenu', card.firstChild!);
    expect(tracker.take()).toBe(card);
  });

  it('ignores right-clicks the page dispatches itself, which could plant a target', () => {
    const { tracker, fire } = track();
    fire('contextmenu', button, false);
    expect(tracker.take()).toBeNull();

    fire('contextmenu', card);
    fire('contextmenu', button, false);
    expect(tracker.take()).toBe(card);
  });

  it('forgets the target when the user presses again (maybe opening a menu it never sees)', () => {
    const { tracker, fire } = track();
    fire('contextmenu', card);
    fire('pointerdown', button);
    expect(tracker.take()).toBeNull();

    // A synthetic press doesn't count either way.
    fire('contextmenu', card);
    fire('pointerdown', button, false);
    expect(tracker.take()).toBe(card);
  });

  it('expires the target a short while after the right-click', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { tracker, fire } = track();
    fire('contextmenu', card);
    now.mockReturnValue(1_000_000 + CONTEXT_MENU_TARGET_TTL_MS);
    expect(tracker.take()).toBe(card);

    now.mockReturnValue(2_000_000);
    fire('contextmenu', card);
    now.mockReturnValue(2_000_000 + CONTEXT_MENU_TARGET_TTL_MS + 1);
    expect(tracker.take()).toBeNull();
  });

  it('ignores the page body, removed elements and WebMark’s own UI', () => {
    const { tracker, fire } = track();
    fire('contextmenu', document.body);
    expect(tracker.take()).toBeNull();

    fire('contextmenu', button);
    button.remove();
    expect(tracker.take()).toBeNull();

    const host = document.createElement('webmark-ui');
    const inner = document.createElement('span');
    host.append(inner);
    document.body.append(host);
    fire('contextmenu', inner);
    expect(tracker.take()).toBeNull();
  });
});

describe('addNoteMenuMessage', () => {
  it('opens the editor for the right-clicked element in the top frame', () => {
    expect(addNoteMenuMessage(0)).toEqual({ type: 'wm:note-from-context-menu' });
    expect(addNoteMenuMessage(undefined)).toEqual({ type: 'wm:note-from-context-menu' });
  });

  it('starts the picker for a right-click inside an iframe, which the page script never sees', () => {
    expect(addNoteMenuMessage(3)).toEqual({ type: 'wm:start-picker' });
  });
});
