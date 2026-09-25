import { describe, expect, it } from 'vitest';
import { createAnchor, resolveAnchor } from '@/lib/anchor';
import type { ElementAnchor } from '@/lib/types';

/*
 * jsdom is 10-50x slower than a browser, so bounds are loose. Note that jsdom's
 * own selector engine is quadratic for :nth-of-type over thousands of flat
 * siblings (browsers are not), so the flat-list case strips the stored
 * locators to measure only our code.
 */

const GROUPS = 100;
const ROWS_PER_GROUP = 25; // 100 × (section + h2 + ul + 25 × 4) ≈ 10.3k elements

function rowHtml(label: string): string {
  return `<li class="row"><span class="name">Item ${label}</span><span class="price">$${label.length}.00</span><button>Buy</button></li>`;
}

function renderGroups(groups: number[]): void {
  document.body.innerHTML = `<div id="app">${groups
    .map(
      (g) =>
        `<section class="group"><h2>Group ${g}</h2><ul>${Array.from({ length: ROWS_PER_GROUP }, (_, r) => rowHtml(`${g}-${r + 1}`)).join('')}</ul></section>`,
    )
    .join('')}</div>`;
}

function renderFlat(rows: number[]): void {
  document.body.innerHTML = `<div id="app"><ul class="rows">${rows.map((n) => rowHtml(String(n))).join('')}</ul></div>`;
}

function row(label: string): Element {
  const name = Array.from(document.querySelectorAll('.name')).find((el) => el.textContent === `Item ${label}`);
  if (!name?.parentElement) throw new Error(`row ${label} missing`);
  return name.parentElement;
}

/**
 * Best of `runs` timings. One run swings with JIT warm-up, GC and whatever
 * else the machine is doing; a real slowdown shows up in every run.
 * resolveAnchor only reads the DOM, so the runs are identical.
 */
function timed<T>(fn: () => T, runs = 3): { value: T; ms: number } {
  let result: { value: T; ms: number } | undefined;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    const value = fn();
    const ms = performance.now() - start;
    if (!result || ms < result.ms) result = { value, ms };
  }
  return result!;
}

const groups = Array.from({ length: GROUPS }, (_, i) => i + 1);

describe('resolveAnchor performance on a 10k-element page', () => {
  it('builds a 10k-element fixture', () => {
    renderGroups(groups);
    expect(document.body.getElementsByTagName('*').length).toBeGreaterThanOrEqual(10000);
  });

  it('resolves an unchanged page through the selector', () => {
    renderGroups(groups);
    const target = row('50-12');
    const anchor = createAnchor(target);
    const { value, ms } = timed(() => resolveAnchor(anchor, document));
    expect(value?.element).toBe(target);
    expect(ms).toBeLessThan(100);
  });

  it('falls back to fuzzy search within budget after the page shifts', () => {
    renderGroups(groups);
    const anchor = createAnchor(row('50-12'));
    renderGroups([0, ...groups]); // selector and XPath now point one group too early
    const target = row('50-12');

    const { value, ms } = timed(() => resolveAnchor(anchor, document));
    expect(value?.element).toBe(target);
    expect(value?.method).toBe('fuzzy');
    expect(ms).toBeLessThan(300);
  });

  it('returns null within budget when the element is gone', () => {
    renderGroups(groups);
    const anchor = createAnchor(row('50-12'));
    row('50-12').remove();
    const { value, ms } = timed(() => resolveAnchor(anchor, document));
    expect(value).toBeNull();
    expect(ms).toBeLessThan(300);
  });

  it(
    'scores 2,500 flat siblings in linear time',
    () => {
      const all = Array.from({ length: 2500 }, (_, i) => i + 1);
      renderFlat(all);
      const anchor: ElementAnchor = { ...createAnchor(row('1234')), selector: '', xpath: '' };
      renderFlat([0, ...all]);
      const target = row('1234');

      const { value, ms } = timed(() => resolveAnchor(anchor, document));
      expect(value?.element).toBe(target);
      expect(ms).toBeLessThan(300);
    },
    30_000,
  );

  it(
    'tells 1,000 identical "Edit" links apart by their rows within budget',
    () => {
      const table = (customers: number[]) => {
        document.body.innerHTML = `<div id="app"><table><tbody>${customers
          .map((n) => `<tr><td>Customer ${n}</td><td>customer${n}@example.com</td><td><a href="#" class="edit">Edit</a></td></tr>`)
          .join('')}</tbody></table></div>`;
      };
      const editLink = (n: number) => {
        const cell = Array.from(document.querySelectorAll('td')).find((td) => td.textContent === `Customer ${n}`);
        return cell?.parentElement?.querySelector('a') ?? null;
      };
      const all = Array.from({ length: 1000 }, (_, i) => i + 1);
      table(all);
      const anchor: ElementAnchor = { ...createAnchor(editLink(500)!), selector: '', xpath: '' };
      expect(anchor.lookAlikes).toBe(999);

      table([...all].reverse());
      const found = timed(() => resolveAnchor(anchor, document));
      expect(found.value?.element).toBe(editLink(500));
      expect(found.ms).toBeLessThan(300);

      table(all.filter((n) => n !== 500));
      const gone = timed(() => resolveAnchor(anchor, document));
      expect(gone.value).toBeNull();
      expect(gone.ms).toBeLessThan(300);
    },
    30_000,
  );
});
