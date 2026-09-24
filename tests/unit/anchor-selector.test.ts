import { beforeEach, describe, expect, it } from 'vitest';
import { buildSelector, buildXPath, evaluateXPath } from '@/lib/anchor';

function mount(html: string): void {
  document.body.innerHTML = html;
}

function byId(id: string): Element {
  const el = document.querySelector(`[data-t="${id}"]`);
  if (!el) throw new Error(`fixture element ${id} missing`);
  return el;
}

function expectUnique(selector: string, el: Element, root: ParentNode = document): void {
  const found = root.querySelectorAll(selector);
  expect(found).toHaveLength(1);
  expect(found[0]).toBe(el);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('buildSelector preference order', () => {
  it('prefers a stable id', () => {
    mount('<button id="save" data-testid="save-btn" class="btn" data-t="x">Save</button>');
    expect(buildSelector(byId('x'))).toBe('#save');
  });

  it('skips a generated id and uses the test attribute', () => {
    mount('<button id=":r1:" data-testid="save-btn" class="btn" data-t="x">Save</button><button class="btn">Other</button>');
    expect(buildSelector(byId('x'))).toBe('[data-testid="save-btn"]');
  });

  it.each(['data-test', 'data-test-id', 'data-cy', 'data-qa'])('supports %s', (attr) => {
    mount(`<div ${attr}="hook" data-t="x"></div><div></div>`);
    expect(buildSelector(byId('x'))).toBe(`[${attr}="hook"]`);
  });

  it('uses [name] before classes', () => {
    mount('<form><input name="email" class="field" data-t="x"><input name="password2" class="field"></form>');
    expect(buildSelector(byId('x'))).toBe('input[name="email"]');
  });

  it('uses [aria-label] before classes', () => {
    mount('<button aria-label="Close" class="icon-btn" data-t="x">×</button><button class="icon-btn">?</button>');
    expect(buildSelector(byId('x'))).toBe('button[aria-label="Close"]');
  });

  it('uses a stable class and ignores hashed / state classes', () => {
    mount(`
      <div class="Card_card__3xYz1 active revenue-card" data-t="x">Revenue</div>
      <div class="Card_card__3xYz1 active">Users</div>`);
    expect(buildSelector(byId('x'))).toBe('div.revenue-card');
  });

  it('prefers semantic classes over utility classes', () => {
    mount('<div class="mt-4 flex pricing" data-t="x"></div><div class="mt-4 flex"></div>');
    expect(buildSelector(byId('x'))).toBe('div.pricing');
  });

  it('scopes under the nearest ancestor with a stable id', () => {
    mount('<ul id="menu"><li>A</li><li data-t="x">B</li><li>C</li></ul><ul><li>D</li><li>E</li></ul>');
    const el = byId('x');
    const selector = buildSelector(el);
    expect(selector.startsWith('#menu ')).toBe(true);
    expectUnique(selector, el);
  });

  it('scopes under an ancestor test id', () => {
    mount('<section data-testid="kpis"><div class="kpi">1</div><div class="kpi" data-t="x">2</div></section><div class="kpi">3</div>');
    const selector = buildSelector(byId('x'));
    expect(selector.startsWith('[data-testid="kpis"] ')).toBe(true);
    expectUnique(selector, byId('x'));
  });

  it('falls back to an nth-of-type path when nothing is stable', () => {
    mount('<div><div class="sc-abc"><span>1</span><span data-t="x">2</span></div><div class="sc-abc"><span>3</span></div></div>');
    const el = byId('x');
    const selector = buildSelector(el);
    expect(selector).toContain(':nth-of-type(');
    expectUnique(selector, el);
  });

  it('escapes awkward ids', () => {
    mount('<div id="a.b" data-t="x"></div><div id="price:total"></div>');
    const selector = buildSelector(byId('x'));
    expect(selector).toBe('#a\\.b');
    expectUnique(selector, byId('x'));
  });

  it('never uses name, placeholder or aria-label of password fields', () => {
    mount('<input type="password" name="secret-pw" placeholder="Your password" data-t="x"><input type="text" name="user">');
    const selector = buildSelector(byId('x'));
    expect(selector).not.toMatch(/secret|Your password/);
    expectUnique(selector, byId('x'));
  });

  it('produces a unique selector for every element of a messy page', () => {
    mount(`
      <header><nav><a href="/">Home</a><a href="/docs">Docs</a><a href="/docs">Docs</a></nav></header>
      <main>
        <section><h2>Dashboard</h2>
          <div class="grid">
            ${Array.from({ length: 6 }, (_, i) => `<div class="card css-1x2y3z"><h3>Card ${i}</h3><p>Body</p><button>Open</button></div>`).join('')}
          </div>
        </section>
        <table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>
      </main>`);
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      expectUnique(buildSelector(el), el);
    }
  });

  it('verifies uniqueness inside a shadow root', () => {
    mount('<div id="host"></div>');
    const host = document.getElementById('host');
    const shadow = host!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div class="panel"><button class="go">Go</button></div><div class="panel"><button class="go">Go</button></div>';
    const target = shadow.querySelectorAll('button')[1]!;
    const selector = buildSelector(target);
    expectUnique(selector, target, shadow);
  });
});

describe('buildXPath', () => {
  it('writes 1-based indices only where same-tag siblings exist', () => {
    mount(`
      <div></div>
      <div><main><section></section><section><div></div><div></div><div data-t="x"></div></section></main></div>`);
    expect(buildXPath(byId('x'))).toBe('/html/body/div[2]/main/section[2]/div[3]');
  });

  it('round-trips through document.evaluate', () => {
    mount('<ul><li>a</li><li>b</li><li data-t="x">c</li></ul>');
    const el = byId('x');
    expect(evaluateXPath(buildXPath(el), document)).toBe(el);
  });

  it('handles SVG elements with a namespace-agnostic step', () => {
    mount('<svg><g></g><g><path data-t="x"></path></g></svg>');
    const el = byId('x');
    const xpath = buildXPath(el);
    expect(xpath).toBe('/html/body/*[1]/*[2]/*[1]');
    expect(evaluateXPath(xpath, document)).toBe(el);
  });

  it('returns null for invalid or dangling paths', () => {
    expect(evaluateXPath('/html/body/div[99]', document)).toBeNull();
    expect(evaluateXPath('///[', document)).toBeNull();
    expect(evaluateXPath('', document)).toBeNull();
  });
});
