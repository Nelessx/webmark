import { describe, expect, it, vi } from 'vitest';
import { lightDomElement } from '@/entrypoints/content/dom';
import { computePageState } from '@/entrypoints/content/pageState';
import { createAppStore, createStore } from '@/entrypoints/content/store';
import type { Note } from '@/lib/types';

function note(id: string, status: Note['status'] = 'open'): Note {
  return { id, status } as Note;
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
      notes: [note('a'), note('b', 'resolved'), note('c')],
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
      openCount: 2,
    });
  });

  it('reports no orphans before the first resolution pass', () => {
    const store = createAppStore('k');
    store.set({ notes: [note('a')] });
    expect(computePageState(store.get()).orphanedIds).toEqual([]);
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
