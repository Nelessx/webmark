import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteCard } from '@/components/NoteCard';
import { NOTE_SCHEMA_VERSION, type Note, type NotePatch } from '@/lib/types';

/*
 * The note card of the side panel and the All notes page: its status and
 * priority menus and its one-click next step send exactly the change asked for.
 */

const base: Note = {
  id: 'n1',
  schemaVersion: NOTE_SCHEMA_VERSION,
  pageKey: 'https://example.com/',
  url: 'https://example.com/',
  pageTitle: 'Example',
  label: 'Users card',
  body: 'Count only active users',
  status: 'open',
  priority: 'medium',
  tags: [],
  author: '',
  anchor: {
    selector: '#users',
    xpath: '/html/body/div[1]',
    tagName: 'div',
    classes: [],
    attributes: {},
    text: 'Users',
    rect: { x: 0, y: 0, width: 100, height: 50 },
    viewport: { width: 1280, height: 800 },
    ancestorTags: ['body'],
    nthOfType: 1,
  },
  hasScreenshot: false,
  createdAt: 1,
  updatedAt: 1,
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
});

function renderCard(note: Note, onUpdate: (patch: NotePatch) => Promise<unknown>) {
  flushSync(() => root.render(<NoteCard note={note} pinNumber={3} onUpdate={onUpdate} onDelete={() => {}} />));
}

const button = (name: string) => {
  const found = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name);
  if (!found) throw new Error(`No button named "${name}"`);
  return found;
};

const menu = () => container.querySelector<HTMLElement>('[role="menu"]');
const menuItems = () => [...container.querySelectorAll<HTMLButtonElement>('[role="menu"] [role^="menuitem"]')];
const item = (label: string) => {
  const found = menuItems().find((i) => i.textContent === label);
  if (!found) throw new Error(`No menu item "${label}"`);
  return found;
};

describe('note card status and priority', () => {
  it('shows the status and priority, and offers every status in the status menu', async () => {
    const onUpdate = vi.fn(async (_patch: NotePatch) => {});
    renderCard(base, onUpdate);
    const article = container.querySelector('article')!;
    expect(article.getAttribute('data-status')).toBe('open');
    expect(article.getAttribute('data-priority')).toBe('medium');

    const status = button('Status: Open');
    expect(status.getAttribute('aria-haspopup')).toBe('menu');
    expect(status.getAttribute('aria-expanded')).toBe('false');
    status.click();
    await vi.waitFor(() => expect(menu()).not.toBeNull());
    expect(status.getAttribute('aria-expanded')).toBe('true');
    expect(menu()!.getAttribute('aria-label')).toBe('Status');
    expect(menuItems().map((i) => [i.textContent, i.getAttribute('role'), i.getAttribute('aria-checked')])).toEqual([
      ['Open', 'menuitemradio', 'true'],
      ['In progress', 'menuitemradio', 'false'],
      ['Completed', 'menuitemradio', 'false'],
      ['Archived', 'menuitemradio', 'false'],
    ]);

    item('Archived').click();
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ status: 'archived' }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it('sets the priority from the priority menu', async () => {
    const onUpdate = vi.fn(async (_patch: NotePatch) => {});
    renderCard(base, onUpdate);
    button('Priority: Medium').click();
    await vi.waitFor(() => expect(menu()).not.toBeNull());
    expect(menuItems().map((i) => i.textContent)).toEqual(['High', 'Medium', 'Low']);
    item('High').click();
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ priority: 'high' }));
  });

  it('choosing the current status or priority writes nothing', async () => {
    const onUpdate = vi.fn(async (_patch: NotePatch) => {});
    renderCard({ ...base, status: 'in_progress', priority: 'low' }, onUpdate);
    button('Status: In progress').click();
    await vi.waitFor(() => expect(menu()).not.toBeNull());
    item('In progress').click();
    button('Priority: Low').click();
    await vi.waitFor(() => expect(menu()).not.toBeNull());
    item('Low').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['open', 'Start', 'in_progress'],
    ['in_progress', 'Complete', 'completed'],
    ['completed', 'Reopen', 'open'],
    ['archived', 'Unarchive', 'open'],
  ] as const)('from %s, the one-click "%s" moves the note to %s', async (status, label, next) => {
    const onUpdate = vi.fn(async (_patch: NotePatch) => {});
    renderCard({ ...base, status }, onUpdate);
    button(label).click();
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ status: next }));
  });

  it('works from the keyboard: arrows move, Enter picks, Escape closes back on the button', async () => {
    const onUpdate = vi.fn(async (_patch: NotePatch) => {});
    renderCard(base, onUpdate);
    const status = button('Status: Open');
    status.focus();
    status.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    // Opens on the current status.
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Open'));
    const key = (k: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('ArrowDown');
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('In progress'));
    key('End');
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Archived'));
    key('ArrowDown');
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Open'));
    // Type-ahead.
    key('c');
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Completed'));
    key('Escape');
    await vi.waitFor(() => expect(menu()).toBeNull());
    expect(document.activeElement).toBe(status);
    expect(onUpdate).not.toHaveBeenCalled();

    status.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Archived'));
    (document.activeElement as HTMLButtonElement).click();
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ status: 'archived' }));
    expect(document.activeElement).toBe(status);
  });

  it('closes the menu on a press elsewhere', async () => {
    renderCard(base, async () => {});
    button('Status: Open').click();
    await vi.waitFor(() => expect(menu()).not.toBeNull());
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await vi.waitFor(() => expect(menu()).toBeNull());
  });

  it('closes the menu when focus moves on to something else, but not while it moves inside', async () => {
    renderCard(base, async () => {});
    const outside = document.createElement('input');
    document.body.append(outside);
    button('Priority: Medium').click();
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Medium'));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Low'));
    expect(menu()).not.toBeNull();
    outside.focus();
    await vi.waitFor(() => expect(menu()).toBeNull());
    outside.remove();
  });

  it('marks a high-priority note on its pin badge', () => {
    renderCard({ ...base, priority: 'high', status: 'completed' }, async () => {});
    const pin = container.querySelector('.wm-pin')!;
    expect(pin.textContent).toBe('3');
    expect(pin.getAttribute('data-priority')).toBe('high');
    expect(pin.getAttribute('data-status')).toBe('completed');
  });

  it('reports a failed change and keeps the note as it was', async () => {
    const onUpdate = vi.fn(async (_patch: NotePatch) => Promise.reject(new Error('storage full')));
    renderCard(base, onUpdate);
    button('Start').click();
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ status: 'in_progress' }));
    expect(container.querySelector('article')!.getAttribute('data-status')).toBe('open');
  });
});
