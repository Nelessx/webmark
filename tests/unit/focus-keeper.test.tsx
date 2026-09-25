import { useRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteCard } from '@/components/NoteCard';
import { useFocusKeeper, type FocusHome } from '@/components/useFocusKeeper';
import { NOTE_SCHEMA_VERSION, type Note, type NotePatch } from '@/lib/types';

/*
 * A card that leaves the list (archived under "All", deleted) or moves takes
 * keyboard focus with it: useFocusKeeper hands it to the card in its place.
 */

function makeNote(id: string, overrides: Partial<Note> = {}): Note {
  return {
    id,
    schemaVersion: NOTE_SCHEMA_VERSION,
    pageKey: 'https://example.com/',
    url: 'https://example.com/',
    pageTitle: 'Example',
    label: `Card ${id}`,
    body: `Note ${id}`,
    status: 'open',
    priority: 'medium',
    tags: [],
    author: '',
    anchor: {
      selector: `#${id}`,
      xpath: '/html/body/div[1]',
      tagName: 'div',
      classes: [],
      attributes: {},
      text: id,
      rect: { x: 0, y: 0, width: 100, height: 50 },
      viewport: { width: 1280, height: 800 },
      ancestorTags: ['body'],
      nthOfType: 1,
    },
    hasScreenshot: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

interface ListProps {
  notes: Note[];
  /** Buttons of a toolbar above the cards (like the bulk bar). */
  toolbar?: string[];
  home?: FocusHome;
}

let notes: Note[];
const onUpdate = vi.fn(async (id: string, patch: NotePatch) => {
  notes = notes.map((n) => (n.id === id ? { ...n, ...patch } : n));
});
const onDelete = vi.fn(async (id: string) => {
  notes = notes.filter((n) => n.id !== id);
});

/** Like the lists under "All": archived notes are left out, and an empty list offers them. */
function List({ notes, toolbar, home }: ListProps) {
  const ref = useRef<HTMLElement>(null);
  const listed = notes.filter((n) => n.status !== 'archived');
  useFocusKeeper(ref, listed.map((n) => n.id), home);
  return (
    <main ref={ref} tabIndex={-1}>
      {toolbar ? (
        <div role="toolbar" aria-label="Bulk actions">
          {toolbar.map((name) => (
            <button key={name} type="button">
              {name}
            </button>
          ))}
        </div>
      ) : null}
      {listed.map((note) => (
        <NoteCard
          key={note.id}
          note={note}
          selectable
          onUpdate={(patch) => onUpdate(note.id, patch)}
          onDelete={() => onDelete(note.id)}
        />
      ))}
      {listed.length ? null : <button type="button">Show archived</button>}
    </main>
  );
}

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onUpdate.mockClear();
  onDelete.mockClear();
});

afterEach(() => {
  root.unmount();
  container.remove();
});

/** Render the list as storage has it now (what a storage change does in the real lists). */
function render(props: Omit<ListProps, 'notes'> = {}) {
  flushSync(() => root.render(<List notes={notes} {...props} />));
}

const card = (id: string) => container.querySelector<HTMLElement>(`article[data-note-id="${id}"]`);
const control = (id: string, name: string) => {
  const found = card(id)?.querySelector<HTMLElement>(`[data-card-control="${name}"]`);
  if (!found) throw new Error(`No ${name} control on card ${id}`);
  return found;
};
const button = (name: string) => {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === name);
  if (!found) throw new Error(`No button "${name}"`);
  return found;
};

/** Archive a card from the keyboard: its status menu, ↑ (to Archived), Enter. */
async function archiveFromKeyboard(id: string) {
  const status = control(id, 'status');
  status.focus();
  status.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Archived'));
  (document.activeElement as HTMLElement).click();
  await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith(id, { status: 'archived' }));
  // Back on the menu's button until the change reaches the list.
  expect(document.activeElement).toBe(status);
}

describe('keyboard focus when a card leaves the list', () => {
  it('archiving a card moves focus to the same control on the next card', async () => {
    notes = [makeNote('a'), makeNote('b'), makeNote('c')];
    render();
    await archiveFromKeyboard('b');

    render();
    expect(card('b')).toBeNull();
    expect(document.activeElement).toBe(control('c', 'status'));
  });

  it('archiving the last card moves focus to the card before it', async () => {
    notes = [makeNote('a'), makeNote('b'), makeNote('c')];
    render();
    await archiveFromKeyboard('c');

    render();
    expect(document.activeElement).toBe(control('b', 'status'));
  });

  it('archiving the only card moves focus to what the empty list offers', async () => {
    notes = [makeNote('a')];
    render();
    await archiveFromKeyboard('a');

    render();
    expect(document.activeElement).toBe(button('Show archived'));
  });

  it('deleting a card moves focus to the next card’s delete button', async () => {
    notes = [makeNote('a'), makeNote('b')];
    render();
    const remove = control('a', 'delete');
    remove.focus();
    remove.click();
    await vi.waitFor(() => expect(remove.textContent).toBe('Delete?'));
    remove.click();
    await vi.waitFor(() => expect(onDelete).toHaveBeenCalledWith('a'));

    render();
    expect(document.activeElement).toBe(control('b', 'delete'));
  });

  it('keeps focus on a card that moved (re-sorted)', () => {
    notes = [makeNote('a'), makeNote('b'), makeNote('c')];
    render();
    control('a', 'priority').focus();

    notes = [notes[1]!, notes[2]!, notes[0]!];
    render();
    expect(document.activeElement).toBe(control('a', 'priority'));
  });

  it('leaves focus alone once the user pressed somewhere else', async () => {
    notes = [makeNote('a'), makeNote('b')];
    render();
    await archiveFromKeyboard('a');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

    render();
    expect(card('a')).toBeNull();
    expect(control('b', 'status')).not.toBe(document.activeElement);
  });
});

describe('keyboard focus when a toolbar changes', () => {
  it('a toolbar button that goes away hands focus to the toolbar’s first control', () => {
    notes = [makeNote('a')];
    render({ toolbar: ['Select all', 'Set status'] });
    button('Select all').focus();

    render({ toolbar: ['Set status'] });
    expect(document.activeElement).toBe(button('Set status'));
  });

  it('when the toolbar goes, focus goes to the home card, or the one in its place', () => {
    notes = [makeNote('a'), makeNote('b'), makeNote('c'), makeNote('d')];
    render({ toolbar: ['Set status'], home: { cardId: 'b', control: 'select' } });
    button('Set status').focus();

    // b and c archived together; the selection (and so the toolbar) is gone.
    notes = notes.map((n) => (n.id === 'b' || n.id === 'c' ? { ...n, status: 'archived' } : n));
    render();
    expect(document.activeElement).toBe(control('d', 'select'));
  });

  it('when the toolbar goes and the home card stays, focus goes to that card', () => {
    notes = [makeNote('a'), makeNote('b')];
    render({ toolbar: ['Clear selection'], home: { cardId: 'b', control: 'select' } });
    button('Clear selection').focus();

    render();
    expect(document.activeElement).toBe(control('b', 'select'));
  });
});
