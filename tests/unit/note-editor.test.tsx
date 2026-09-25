import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NoteEditor } from '@/components/NoteEditor';
import { NOTE_SCHEMA_VERSION, type Note, type NotePatch } from '@/lib/types';

/*
 * The inline editor of the dashboard and side panel. It used to compare the
 * form with the live note, so when the note was edited elsewhere while the form
 * was open (e.g. on the page), saving wrote the untouched fields back with
 * their old values.
 */

const note: Note = {
  id: 'n1',
  schemaVersion: NOTE_SCHEMA_VERSION,
  pageKey: 'https://example.com/',
  url: 'https://example.com/',
  pageTitle: 'Example',
  label: 'Users card',
  body: 'Count only active users',
  status: 'open',
  priority: 'medium',
  tags: ['data'],
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

/** Type into a React-controlled field the way a user would. */
function typeInto(field: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

function typeIntoTextarea(field: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Pick an option of a React-controlled select the way a user would. */
function choose(label: string, value: string): void {
  const select = [...container.querySelectorAll('label')].find((l) => l.textContent === label)?.control;
  if (!(select instanceof HTMLSelectElement)) throw new Error(`No select labelled "${label}"`);
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function selectNamed(label: string): HTMLSelectElement {
  const select = [...container.querySelectorAll('label')].find((l) => l.textContent === label)?.control;
  if (!(select instanceof HTMLSelectElement)) throw new Error(`No select labelled "${label}"`);
  return select;
}

/** Rendered synchronously, so a click right after sees the new props. */
function renderEditor(current: Note, onSave: (patch: NotePatch) => Promise<void>, onCancel = () => {}) {
  flushSync(() => root.render(<NoteEditor note={current} onSave={onSave} onCancel={onCancel} />));
}

it('saves only the fields edited in the form, even when the note changed meanwhile', async () => {
  const onSave = vi.fn(async (_patch: NotePatch) => {});
  renderEditor(note, onSave);

  // Edited elsewhere while the form is open.
  renderEditor(
    { ...note, body: 'Count users active in the last 30 days', tags: ['data', 'metrics'], status: 'completed', priority: 'low' },
    onSave,
  );
  typeInto(container.querySelector<HTMLInputElement>('input[placeholder^="Dashboard"]')!, 'Active users card');
  container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();

  await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave).toHaveBeenCalledWith({ label: 'Active users card' });
});

it('offers every status and priority, starting from the note’s own', () => {
  renderEditor({ ...note, status: 'in_progress', priority: 'high' }, async () => {});
  const status = selectNamed('Status');
  const priority = selectNamed('Priority');
  expect([...status.options].map((o) => [o.value, o.text])).toEqual([
    ['open', 'Open'],
    ['in_progress', 'In progress'],
    ['completed', 'Completed'],
    ['archived', 'Archived'],
  ]);
  expect([...priority.options].map((o) => [o.value, o.text])).toEqual([
    ['high', 'High'],
    ['medium', 'Medium'],
    ['low', 'Low'],
  ]);
  expect(status.value).toBe('in_progress');
  expect(priority.value).toBe('high');
});

it('saves a status or priority chosen in the form as an edited field, and only then', async () => {
  const onSave = vi.fn(async (_patch: NotePatch) => {});
  renderEditor(note, onSave);
  choose('Status', 'archived');
  container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith({ status: 'archived' }));

  onSave.mockClear();
  root.unmount();
  root = createRoot(container);
  renderEditor(note, onSave);
  choose('Priority', 'high');
  // Changed back and forth: not an edit.
  choose('Status', 'completed');
  choose('Status', 'open');
  container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave).toHaveBeenCalledWith({ priority: 'high' });
});

it('cannot save an emptied note, like the editor on the page', async () => {
  const onSave = vi.fn(async (_patch: NotePatch) => {});
  renderEditor(note, onSave);
  const body = container.querySelector<HTMLTextAreaElement>('textarea')!;
  const save = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;

  typeIntoTextarea(body, '   \n ');
  await vi.waitFor(() => expect(save.disabled).toBe(true));
  // Neither the button nor Ctrl+Enter saves it.
  save.click();
  body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(onSave).not.toHaveBeenCalled();

  typeIntoTextarea(body, 'Count weekly actives');
  await vi.waitFor(() => expect(save.disabled).toBe(false));
  save.click();
  await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith({ body: 'Count weekly actives' }));
});

it('closes without saving when nothing was edited in the form', async () => {
  const onSave = vi.fn(async (_patch: NotePatch) => {});
  const onCancel = vi.fn();
  renderEditor(note, onSave, onCancel);

  renderEditor({ ...note, body: 'Changed elsewhere' }, onSave, onCancel);
  container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();

  await vi.waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  expect(onSave).not.toHaveBeenCalled();
});
