import { describe, expect, it, vi } from 'vitest';
import { lightDomElement } from '@/entrypoints/content/dom';
import { computePageState } from '@/entrypoints/content/pageState';
import { createAppStore, createStore, hasPin, selectLayoutTargets } from '@/entrypoints/content/store';
import type { Note } from '@/lib/types';

function note(id: string, status: Note['status'] = 'open'): Note {
  return { id, status, priority: 'medium' } as Note;
}

describe('createStore', () => {
  it('notifies only when a field actually changes', () => {
    const store = createStore({ a: 1, b: 'x' });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ a: 1 });
    expect(listener).not.toHaveBeenCalled();
    const before = store.get();
    store.set((s) => ({ a: s.a + 1 }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({ a: 2, b: 'x' });
    expect(store.get()).not.toBe(before);
  });

  it('stops notifying after unsubscribe', () => {
    const store = createStore({ a: 1 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.set({ a: 2 });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('computePageState', () => {
  it('splits resolved and orphaned notes and counts open ones', () => {
    const store = createAppStore('https://example.com/page');
    const el = document.createElement('div');
    store.set({
      notes: [note('a'), note('b', 'completed'), note('c')],
      resolved: new Map([['a', el]]),
      resolvedOnce: true,
      pickerActive: true,
    });
    expect(computePageState(store.get())).toMatchObject({
      pageKey: 'https://example.com/page',
      pinsVisible: true,
      pickerActive: true,
      resolvedIds: ['a'],
      orphanedIds: ['b', 'c'],
      activeCount: 2,
    });
  });

  it('counts every status, and as active (the toolbar badge) only open and in-progress notes', () => {
    const store = createAppStore('k');
    store.set({
      notes: [note('a'), note('b', 'in_progress'), note('c', 'in_progress'), note('d', 'completed'), note('e', 'archived')],
    });
    const state = computePageState(store.get());
    expect(state.statusCounts).toEqual({ open: 1, in_progress: 2, completed: 1, archived: 1 });
    expect(state.activeCount).toBe(3);

    store.set({ notes: [note('d', 'completed'), note('e', 'archived')] });
    expect(computePageState(store.get())).toMatchObject({
      activeCount: 0,
      statusCounts: { open: 0, in_progress: 0, completed: 1, archived: 1 },
    });
  });

  it('never reports an archived note as not found: it has no pin', () => {
    const store = createAppStore('k');
    const el = document.createElement('div');
    store.set({
      notes: [note('found-archived', 'archived'), note('gone-archived', 'archived'), note('gone-open')],
      resolved: new Map([['found-archived', el]]),
      resolvedOnce: true,
    });
    expect(computePageState(store.get())).toMatchObject({
      resolvedIds: ['found-archived'],
      orphanedIds: ['gone-open'],
      activeCount: 1,
    });
  });

  it('reports no orphans before the first resolution pass', () => {
    const store = createAppStore('k');
    store.set({ notes: [note('a')] });
    expect(computePageState(store.get()).orphanedIds).toEqual([]);
  });
});

describe('pins and layout targets', () => {
  it('gives every note but archived ones a pin', () => {
    expect(['open', 'in_progress', 'completed', 'archived'].map((s) => hasPin(note('x', s as Note['status'])))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("measures the elements of pinned notes only, while pins are shown, plus the editor's target", () => {
    const store = createAppStore('k');
    const [open, done, archived, target] = ['a', 'b', 'c', 'd'].map(() => document.createElement('div'));
    store.set({
      notes: [note('a'), note('b', 'completed'), note('c', 'archived')],
      resolved: new Map([
        ['a', open!],
        ['b', done!],
        ['c', archived!],
      ]),
    });
    expect(selectLayoutTargets(store.get())).toEqual([open, done]);

    store.set({ settings: { ...store.get().settings, pinsVisible: false } });
    expect(selectLayoutTargets(store.get())).toEqual([]);

    // An archived note can still be opened in the editor (e.g. from the side panel).
    store.set({ editor: { target } as never });
    expect(selectLayoutTargets(store.get())).toEqual([target]);
  });
});

describe('lightDomElement', () => {
  it('maps text nodes to their parent element', () => {
    const p = document.createElement('p');
    p.textContent = 'hello';
    document.body.append(p);
    expect(lightDomElement(p.firstChild)).toBe(p);
    p.remove();
  });

  it('maps elements inside (nested) shadow roots to the outermost host', () => {
    const outer = document.createElement('div');
    document.body.append(outer);
    const inner = document.createElement('span');
    outer.attachShadow({ mode: 'open' }).append(inner);
    const deepest = document.createElement('b');
    inner.attachShadow({ mode: 'open' }).append(deepest);
    expect(lightDomElement(deepest)).toBe(outer);
    outer.remove();
  });

  it('ignores non-node targets', () => {
    expect(lightDomElement(window)).toBeNull();
    expect(lightDomElement(null)).toBeNull();
  });
});
