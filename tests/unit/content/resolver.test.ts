import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { createAnchor, resolveAnchor } from '@/lib/anchor';
import { NOTE_SCHEMA_VERSION, type ElementAnchor, type Note } from '@/lib/types';
import { NoteResolver } from '@/entrypoints/content/resolver';
import { createAppStore } from '@/entrypoints/content/store';

/*
 * NoteResolver against the real anchor module: kept elements are re-verified
 * when their content changes in place (recycled DOM nodes), live content does
 * not flap or re-resolve constantly, and orphans stay on their backoff.
 */

vi.mock('@/lib/anchor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/anchor')>();
  return { ...actual, resolveAnchor: vi.fn(actual.resolveAnchor) };
});

const resolveSpy = vi.mocked(resolveAnchor);

let invalidate: (() => void)[] = [];

function note(id: string, anchor: ElementAnchor): Note {
  return {
    id,
    schemaVersion: NOTE_SCHEMA_VERSION,
    pageKey: 'k',
    url: 'http://example.com/',
    pageTitle: '',
    label: '',
    body: 'b',
    status: 'open',
    priority: 'medium',
    tags: [],
    author: '',
    anchor,
    hasScreenshot: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function setup(notes: Note[]) {
  const ctx = {
    isInvalid: false,
    onInvalidated: (callback: () => void) => invalidate.push(callback),
    addEventListener() {},
  } as unknown as ContentScriptContext;
  const store = createAppStore('k');
  store.set({ notes });
  const resolver = new NoteResolver(ctx, store, document.createElement('webmark-ui'), () => {});
  return { store, resolver, resolved: (id: string) => store.get().resolved.get(id) };
}

/** Calls to resolveAnchor for `note` since the last mockClear(). */
function resolvesOf(n: Note): number {
  return resolveSpy.mock.calls.filter(([anchor]) => anchor === n.anchor).length;
}

/** Rewrite text in place, the way frameworks update a recycled node (a characterData mutation). */
function setTexts(nodes: Element[], texts: string[]): void {
  nodes.forEach((node, i) => {
    (node.firstChild as Text).nodeValue = texts[i] ?? '';
  });
}

afterEach(() => {
  invalidate.forEach((callback) => callback());
  invalidate = [];
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('recycled DOM nodes', () => {
  const invoices = () => {
    document.body.innerHTML = `<table><tbody>
      <tr><td>Invoice A-100</td><td>Acme</td></tr>
      <tr><td>Invoice B-200</td><td>Globex</td></tr>
      <tr><td>Invoice C-300</td><td>Initech</td></tr></tbody></table>`;
    return { rows: Array.from(document.querySelectorAll('tr')), cells: Array.from(document.querySelectorAll('td')) };
  };

  it('drops a row whose content was swapped for another record, on an explicit sync', () => {
    const { rows, cells } = invoices();
    const { resolver, resolved } = setup([note('n1', createAnchor(rows[1]!))]);
    resolver.sync();
    expect(resolved('n1')).toBe(rows[1]);

    setTexts(cells, ['Invoice D-400', 'Hooli', 'Invoice E-500', 'Umbrella', 'Invoice F-600', 'Soylent']);
    resolver.sync();
    expect(resolved('n1')).toBeUndefined();
  });

  it('moves to the node that now shows its record (index-keyed re-sort)', () => {
    const { rows, cells } = invoices();
    const { resolver, resolved } = setup([note('n1', createAnchor(rows[1]!))]);
    resolver.sync();

    setTexts(cells, ['Invoice C-300', 'Initech', 'Invoice A-100', 'Acme', 'Invoice B-200', 'Globex']);
    resolver.sync();
    expect(resolved('n1')).toBe(rows[2]);
  });

  it('notices the rewrite by itself', async () => {
    vi.useFakeTimers();
    const { rows, cells } = invoices();
    const { resolver, resolved } = setup([note('n1', createAnchor(rows[1]!))]);
    resolver.sync();

    setTexts(cells, ['Invoice C-300', 'Initech', 'Invoice A-100', 'Acme', 'Invoice B-200', 'Globex']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(resolved('n1')).toBe(rows[2]);

    setTexts(cells, ['Invoice D-400', 'Hooli', 'Invoice E-500', 'Umbrella', 'Invoice F-600', 'Soylent']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(resolved('n1')).toBeUndefined();
  });

  it('verifies a changed element before handing it out', () => {
    const { rows, cells } = invoices();
    const { resolver, resolved } = setup([note('n1', createAnchor(rows[1]!))]);
    resolver.sync();

    setTexts(cells, ['Invoice D-400', 'Hooli', 'Invoice E-500', 'Umbrella', 'Invoice F-600', 'Soylent']);
    expect(resolver.elementFor('n1')).toBeNull();
    expect(resolved('n1')).toBeUndefined();
  });

  it('notices a recycled card around an unchanged button', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div id="list">${['Blue Shirt', 'Red Hat', 'Green Scarf']
      .map((title) => `<div class="product"><h3>${title}</h3><button class="buy">Add to cart</button></div>`)
      .join('')}</div>`;
    const buttons = Array.from(document.querySelectorAll('button'));
    const titles = Array.from(document.querySelectorAll('h3'));
    const { resolver, resolved } = setup([note('n1', createAnchor(buttons[1]!))]);
    resolver.sync();
    expect(resolved('n1')).toBe(buttons[1]);

    // Re-sorted with index keys: same nodes, the titles move; the buttons don't change at all.
    setTexts(titles, ['Green Scarf', 'Blue Shirt', 'Red Hat']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(resolved('n1')).toBe(buttons[2]);

    setTexts(titles, ['Blue Shirt', 'Green Scarf', 'Yellow Cap']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(resolved('n1')).toBeUndefined();
  });
});

describe('live content', () => {
  const kpis = () => {
    document.body.innerHTML = `
      <div class="kpis">
        <div class="kpi"><h3>Revenue</h3><p>$48,210</p></div>
        <div class="kpi"><h3>Users</h3><p>1,204</p></div>
        <div class="kpi"><h3>Updated</h3><p>12:00:00</p></div>
      </div>`;
    return Array.from(document.querySelectorAll('.kpi'));
  };

  it('keeps a ticking KPI without flapping, re-verifying it less and less often', async () => {
    vi.useFakeTimers();
    const [revenue, , clock] = kpis();
    const notes = [note('revenue', createAnchor(revenue!)), note('clock', createAnchor(clock!.querySelector('p')!))];
    const { store, resolver, resolved } = setup(notes);
    resolver.sync();
    const clockValue = clock!.querySelector('p')!;
    resolveSpy.mockClear();

    const seen = new Set<Element | undefined>();
    const unsubscribe = store.subscribe(() => {
      seen.add(resolved('revenue'));
      seen.add(resolved('clock'));
    });
    for (let second = 1; second <= 30; second++) {
      setTexts([revenue!.querySelector('p')!], [`$48,${210 + second * 7}`]);
      setTexts([clockValue], [`12:00:${String(second).padStart(2, '0')}`]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(resolved('revenue')).toBe(revenue);
      expect(resolved('clock')).toBe(clockValue);
    }
    unsubscribe();
    expect([...seen].every((el) => el === revenue || el === clockValue)).toBe(true);
    // Unthrottled, every tick would re-resolve both notes (60 calls).
    expect(resolvesOf(notes[0]!)).toBeLessThanOrEqual(7);
    expect(resolvesOf(notes[1]!)).toBeLessThanOrEqual(7);
  });
});

describe('orphans and cost', () => {
  const page = () => {
    document.body.innerHTML = `
      <main>
        <div id="widget" class="widget"><h3>Weather</h3><p>Sunny</p></div>
        <section class="gone-a"><h2>Old banner</h2></section>
        <section class="gone-b"><h2>Old promo</h2></section>
        <section class="gone-c"><h2>Old survey</h2></section>
      </main>`;
    const widget = document.getElementById('widget')!;
    const orphans = ['.gone-a', '.gone-b', '.gone-c'].map((selector, i) => {
      const el = document.querySelector(selector)!;
      const n = note(`orphan-${i}`, createAnchor(el));
      el.remove();
      return n;
    });
    return { widget, widgetNote: note('widget', createAnchor(widget)), orphans };
  };

  const remount = () => {
    const old = document.getElementById('widget')!;
    old.replaceWith(old.cloneNode(true));
  };

  /** Let a page change retry the orphans once, so they are backing off. */
  const failOrphansOnce = async () => {
    document.querySelector('main')!.append(document.createElement('hr'));
    await vi.advanceTimersByTimeAsync(400);
  };

  it('retries an orphan on the next page change after load (lazy content)', async () => {
    vi.useFakeTimers();
    const { widgetNote, orphans } = page();
    const { resolver, resolved } = setup([widgetNote, orphans[0]!]);
    resolver.sync();
    document.querySelector('main')!.insertAdjacentHTML('beforeend', '<section class="gone-a"><h2>Old banner</h2></section>');
    await vi.advanceTimersByTimeAsync(400);
    expect(resolved('orphan-0')).toBe(document.querySelector('.gone-a'));
  });

  it('re-resolves only the note whose element was lost; orphans stay on their backoff', async () => {
    vi.useFakeTimers();
    const { widgetNote, orphans } = page();
    const { resolver, resolved } = setup([widgetNote, ...orphans]);
    resolver.sync();
    await failOrphansOnce();
    expect(resolved('widget')).toBeDefined();
    resolveSpy.mockClear();

    remount();
    await vi.advanceTimersByTimeAsync(400);
    expect(resolved('widget')).toBe(document.getElementById('widget'));
    expect(resolvesOf(widgetNote)).toBe(1);
    for (const orphan of orphans) expect(resolvesOf(orphan)).toBe(0);
  });

  it('backs off orphans while a widget keeps re-mounting', async () => {
    vi.useFakeTimers();
    const { widgetNote, orphans } = page();
    const { resolver, resolved } = setup([widgetNote, ...orphans]);
    resolver.sync();
    resolveSpy.mockClear();

    for (let i = 0; i < 15; i++) {
      remount();
      await vi.advanceTimersByTimeAsync(2000);
      expect(resolved('widget')).toBe(document.getElementById('widget'));
    }
    expect(resolvesOf(widgetNote)).toBe(15);
    // Re-resolving every orphan on every re-mount would be 15 each.
    for (const orphan of orphans) expect(resolvesOf(orphan)).toBeLessThanOrEqual(6);
  });

  it('picks up an element that appears while its note backs off, without further page changes', async () => {
    vi.useFakeTimers();
    const { widgetNote, orphans } = page();
    const { resolver, resolved } = setup([widgetNote, orphans[0]!]);
    resolver.sync();
    await failOrphansOnce();
    expect(resolved('orphan-0')).toBeUndefined();

    // Too early for a retry: the check this triggers must still schedule one.
    document.querySelector('main')!.insertAdjacentHTML('beforeend', '<section class="gone-a"><h2>Old banner</h2></section>');
    await vi.advanceTimersByTimeAsync(2000);
    expect(resolved('orphan-0')).toBe(document.querySelector('.gone-a'));
  });

  it('does not poll for orphans on a quiet page', async () => {
    vi.useFakeTimers();
    const { widgetNote, orphans } = page();
    const { resolver } = setup([widgetNote, ...orphans]);
    resolver.sync();
    document.querySelector('main')!.append(document.createElement('hr'));
    await vi.advanceTimersByTimeAsync(5000);
    resolveSpy.mockClear();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('watches only the attributes anchoring reads', async () => {
    vi.useFakeTimers();
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const { widgetNote, orphans } = page();
    const { resolver } = setup([widgetNote, ...orphans]);
    resolver.sync();

    const onDocument = observe.mock.calls.find(([target]) => target === document.documentElement);
    expect(onDocument?.[1]?.attributeFilter).toEqual(expect.arrayContaining(['id', 'class', 'data-testid', 'aria-label', 'href']));
    expect(onDocument?.[1]?.attributeFilter).not.toContain('style');

    await vi.advanceTimersByTimeAsync(10_000);
    resolveSpy.mockClear();
    document.querySelector('main')!.setAttribute('style', 'color: red');
    document.querySelector('main')!.setAttribute('data-tracking', '42');
    await vi.advanceTimersByTimeAsync(3000);
    expect(resolveSpy).not.toHaveBeenCalled();

    document.querySelector('main')!.className = 'restyled';
    await vi.advanceTimersByTimeAsync(3000);
    expect(resolveSpy).toHaveBeenCalled();
  });

  it('time-slices a sync over many notes, finishing even when restarted', async () => {
    document.body.innerHTML = `<ul>${Array.from({ length: 40 }, (_, i) => `<li class="entry">Entry number ${i}</li>`).join('')}</ul>`;
    const notes = Array.from(document.querySelectorAll('li')).map((li, i) => note(`n${i}`, createAnchor(li)));
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 3));
    const { store, resolver } = setup(notes);

    resolver.sync();
    const firstSlice = store.get().resolved.size;
    expect(firstSlice).toBeGreaterThan(0);
    expect(firstSlice).toBeLessThan(notes.length);
    expect(store.get().resolvedOnce).toBe(false);

    resolver.sync();
    await vi.waitFor(() => expect(store.get().resolvedOnce).toBe(true));
    expect(store.get().resolved.size).toBe(notes.length);
  });

  it('stops observing once the page script is invalidated', async () => {
    vi.useFakeTimers();
    const { widgetNote, orphans } = page();
    const { resolver } = setup([widgetNote, ...orphans]);
    resolver.sync();
    invalidate.forEach((callback) => callback());
    invalidate = [];
    resolveSpy.mockClear();

    remount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});
