import { beforeEach, describe, expect, it } from 'vitest';
import { createAnchor, resolveAnchor, scoreCandidate } from '@/lib/anchor';
import type { ElementAnchor } from '@/lib/types';

function mount(html: string): void {
  document.body.innerHTML = html;
}

function q(selector: string): Element {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`fixture element ${selector} missing`);
  return el;
}

function card(title: string, body: string, attrs = 'class="card"'): string {
  return `<div ${attrs}><h3>${title}</h3><p>${body}</p></div>`;
}

/** Simulate a redeploy that breaks both stored locators, forcing the fuzzy path. */
function withoutLocators(anchor: ElementAnchor): ElementAnchor {
  return { ...anchor, selector: 'div.__gone__', xpath: '/html/body/nothing' };
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = '';
});

describe('createAnchor', () => {
  it('captures every strategy', () => {
    mount(`
      <main id="app">
        <section>
          <div class="grid">
            <div class="card revenue-card active Card_x__9fZ2a" data-testid="kpi-revenue" role="region">
              <h3>Revenue</h3>
              <p>$12,340   this
                 month</p>
            </div>
          </div>
        </section>
      </main>`);
    const el = q('[data-testid="kpi-revenue"]');
    const anchor = createAnchor(el);

    expect(anchor.selector).toBe('[data-testid="kpi-revenue"]');
    expect(anchor.xpath).toBe('/html/body/main/section/div/div');
    expect(anchor.tagName).toBe('div');
    expect(anchor.id).toBeUndefined();
    expect(anchor.classes).toEqual(['card', 'revenue-card']);
    expect(anchor.attributes).toEqual({ 'data-testid': 'kpi-revenue', role: 'region' });
    expect(anchor.text).toBe('Revenue $12,340 this month');
    expect(anchor.ancestorTags).toEqual(['div', 'section', 'main', 'body']);
    expect(anchor.nthOfType).toBe(1);
    expect(anchor.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(anchor.viewport.width).toBeGreaterThan(0);
  });

  it('stores only stable ids', () => {
    mount('<button id="save">Save</button><button id=":r3:">Other</button>');
    expect(createAnchor(q('#save')).id).toBe('save');
    expect(createAnchor(q('[id=":r3:"]')).id).toBeUndefined();
  });

  it('truncates text to 300 characters and caps ancestors at 12', () => {
    const deep = `${'<div>'.repeat(15)}<p id="deep">${'word '.repeat(200)}</p>${'</div>'.repeat(15)}`;
    mount(deep);
    const anchor = createAnchor(q('#deep'));
    expect(anchor.text.length).toBeLessThanOrEqual(300);
    expect(anchor.text.startsWith('word word')).toBe(true);
    expect(anchor.ancestorTags).toHaveLength(12);
    expect(anchor.ancestorTags).not.toContain('html');
  });

  it('never stores form values, other data-* attributes or password details', () => {
    mount(`
      <form>
        <input id="email" name="email" type="email" placeholder="Email" value="alice@example.com" data-user-id="42">
        <input id="pw" name="password" type="password" placeholder="Password" value="hunter2" aria-label="Password">
        <textarea id="notes" placeholder="Notes">my secret draft</textarea>
        <div id="box">Visible label<textarea>another secret</textarea></div>
        <div id="editor" contenteditable="true" aria-label="Message">typed private text</div>
      </form>`);
    const email = q('#email') as HTMLInputElement;
    email.value = 'typed@example.com';

    const emailAnchor = createAnchor(email);
    expect(emailAnchor.attributes).toEqual({ name: 'email', type: 'email', placeholder: 'Email' });
    expect(emailAnchor.text).toBe('Email');

    const pwAnchor = createAnchor(q('#pw'));
    expect(pwAnchor.attributes).toEqual({ type: 'password' });
    expect(pwAnchor.text).toBe('');

    expect(createAnchor(q('#notes')).text).toBe('Notes');
    expect(createAnchor(q('#box')).text).toBe('Visible label');
    expect(createAnchor(q('#editor')).text).toBe('Message');

    const everything = JSON.stringify(
      ['#email', '#pw', '#notes', '#box', '#editor'].map((selector) => createAnchor(q(selector))),
    );
    for (const secret of ['alice@example.com', 'typed@example.com', 'hunter2', 'secret', 'private', '42']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('normalises href and src', () => {
    mount(`
      <a id="same" href="/docs/start?tab=2#install">Docs</a>
      <a id="hash" href="#pricing">Pricing</a>
      <a id="other" href="https://evil.example.com/path?token=abc">Out</a>
      <a id="js" href="javascript:void(0)">JS</a>
      <img id="img" src="https://cdn.example.com/img/logo.png?v=3" alt="Logo">`);
    expect(createAnchor(q('#same')).attributes.href).toBe('/docs/start?tab=2');
    expect(createAnchor(q('#hash')).attributes.href).toBe(`${location.pathname}#pricing`);
    expect(createAnchor(q('#other')).attributes.href).toBe('https://evil.example.com/path');
    expect(createAnchor(q('#js')).attributes.href).toBeUndefined();
    expect(createAnchor(q('#img')).attributes.src).toBe('/img/logo.png');
  });
});

describe('resolveAnchor', () => {
  const dashboard = () =>
    mount(`
      <main id="dashboard">
        <div class="cards">
          ${card('Revenue', 'Monthly revenue $12,340')}
          ${card('Users', '1,204 active users')}
          ${card('Orders', '312 orders today')}
        </div>
      </main>`);

  it('finds an unchanged element through its selector', () => {
    dashboard();
    const target = q('.card:nth-of-type(2)');
    const result = resolveAnchor(createAnchor(target), document);
    expect(result?.element).toBe(target);
    expect(result?.method).toBe('selector');
    expect(result?.confidence).toBeGreaterThan(0.5);
  });

  it('(a) survives a sibling inserted before the target', () => {
    dashboard();
    const target = q('.card:nth-of-type(2)');
    const anchor = createAnchor(target);
    q('.cards').insertAdjacentHTML('afterbegin', card('Churn', '2.1% monthly churn'));

    // The stored nth-of-type selector now points at the wrong card...
    expect(document.querySelector(anchor.selector)).not.toBe(target);
    // ...but the fingerprint check rejects it and the fuzzy pass finds the real one.
    const result = resolveAnchor(anchor, document);
    expect(result?.element).toBe(target);
  });

  it('(b) survives class names being replaced by hashed ones', () => {
    mount(`
      <div class="cards">
        ${card('Revenue', 'Monthly revenue $12,340', 'class="card revenue-card"')}
        ${card('Users', '1,204 active users', 'class="card users-card"')}
      </div>`);
    const target = q('.users-card');
    const anchor = createAnchor(target);
    expect(anchor.selector).toBe('div.users-card');

    for (const el of Array.from(document.querySelectorAll('.card'))) {
      el.className = `Card_card__3xYz1 ${el.classList.contains('users-card') ? 'Card_users__q9Z2a' : 'Card_revenue__b7K1c'}`;
    }
    q('.cards').insertAdjacentHTML('afterbegin', '<div class="Card_card__3xYz1"><h3>Churn</h3><p>2.1%</p></div>');
    const result = resolveAnchor(anchor, document);
    expect(result?.element).toBe(target);
  });

  it('(c) survives a slight text edit', () => {
    dashboard();
    const target = q('.card:nth-of-type(2)');
    const anchor = createAnchor(target);
    target.querySelector('p')!.textContent = '1,204 active users this week';
    q('.cards').insertAdjacentHTML('afterbegin', card('Churn', '2.1% monthly churn'));

    const result = resolveAnchor(anchor, document);
    expect(result?.element).toBe(target);
    expect(result?.method).toBe('fuzzy');
  });

  it('follows a KPI card whose numbers changed', () => {
    dashboard();
    const target = q('.card:nth-of-type(1)');
    const anchor = createAnchor(target);
    target.querySelector('p')!.textContent = 'Monthly revenue $13,020';
    q('.cards').insertAdjacentHTML('afterbegin', card('Churn', '2.1% monthly churn'));
    expect(resolveAnchor(anchor, document)?.element).toBe(target);
  });

  it('(d) follows an element moved to another parent by its test id', () => {
    mount(`
      <section id="top"><div class="kpi" data-testid="kpi-revenue">Revenue $1</div><div class="kpi" data-testid="kpi-users">Users 5</div></section>
      <section id="bottom"><div class="kpi" data-testid="kpi-orders">Orders 9</div></section>`);
    const target = q('[data-testid="kpi-revenue"]');
    const anchor = createAnchor(target);
    q('#bottom').appendChild(target);

    expect(resolveAnchor(anchor, document)?.element).toBe(target);
    // Even with both locators broken, the test id carries it.
    const fuzzy = resolveAnchor(withoutLocators(anchor), document);
    expect(fuzzy?.element).toBe(target);
    expect(fuzzy?.method).toBe('fuzzy');
  });

  describe('(e/f) twenty look-alike cards', () => {
    const ALL = Array.from({ length: 20 }, (_, i) => i + 1);
    // Re-rendered with fresh nodes, like a framework would. (Moving nodes also
    // trips a jsdom bug where descendant :nth-of-type queries return stale results.)
    const products = (order: number[] = ALL) =>
      mount(`<div id="list">${order.map((n) => card(`Product ${n}`, `Price $${n * 10}`)).join('')}</div>`);
    const product = (n: number) => {
      const heading = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent === `Product ${n}`);
      if (!heading?.parentElement) throw new Error(`Product ${n} missing`);
      return heading.parentElement;
    };

    it('(e) picks the right card after the list is re-rendered in reverse', () => {
      products();
      const anchor = createAnchor(product(7));
      products([...ALL].reverse());
      const target = product(7);

      expect(document.querySelector(anchor.selector)).toBe(product(14));
      const result = resolveAnchor(anchor, document);
      expect(result?.element).toBe(target);
      expect(result?.method).toBe('fuzzy');
    });

    it('(e) picks the right card by text alone when locators are gone', () => {
      products();
      const target = product(12);
      const result = resolveAnchor(withoutLocators(createAnchor(target)), document);
      expect(result?.element).toBe(target);
      expect(result?.method).toBe('fuzzy');
    });

    it('(f) returns null, not a neighbour, when the target is removed', () => {
      products();
      const anchor = createAnchor(product(7));
      products(ALL.filter((n) => n !== 7));

      expect(document.querySelector(anchor.selector)).toBe(product(8));
      expect(resolveAnchor(anchor, document)).toBeNull();
    });

    it('(f) returns null when the target is removed and the list reshuffled', () => {
      products();
      const anchor = createAnchor(product(7));
      products(ALL.filter((n) => n !== 7).reverse());
      expect(resolveAnchor(anchor, document)).toBeNull();
    });

    it('(f) returns null when the target is removed in place', () => {
      products();
      const target = product(7);
      const anchor = createAnchor(target);
      target.remove();
      expect(resolveAnchor(anchor, document)).toBeNull();
    });
  });

  it('(f) returns null when a distinct card is removed and another slides into its slot', () => {
    dashboard();
    const target = q('.card:nth-of-type(2)');
    const anchor = createAnchor(target);
    target.remove();
    expect(resolveAnchor(anchor, document)).toBeNull();
  });

  it('returns null when one card with a similar title takes the removed card’s place', () => {
    mount(`<div class="cards">${card('Monthly revenue', '$1,200')}${card('Monthly revenue target', 'on track')}</div>`);
    const target = q('.card:nth-of-type(1)');
    const anchor = createAnchor(target);
    target.remove();
    expect(resolveAnchor(anchor, document)).toBeNull();
  });

  it('returns null when two identical candidates remain and locators are gone', () => {
    mount(`<div>${card('Plan', 'Choose')}</div><div>${card('Plan', 'Choose')}</div>`);
    const anchor = withoutLocators(createAnchor(q('.card')));
    expect(resolveAnchor(anchor, document)).toBeNull();
  });

  it('keeps an id-anchored element whose text was rewritten', () => {
    mount('<div id="status" class="badge">Loading…</div><div class="badge">Other</div>');
    const target = q('#status');
    const anchor = createAnchor(target);
    target.textContent = 'All systems operational';
    const result = resolveAnchor(anchor, document);
    expect(result?.element).toBe(target);
    expect(result?.method).toBe('selector');
  });

  it('rejects a selector hit whose test id now belongs to something else', () => {
    mount('<div class="kpi" data-testid="kpi-a">Alpha</div>');
    const anchor = createAnchor(q('.kpi'));
    mount('<div class="kpi" data-testid="kpi-b">Alpha</div>');
    expect(resolveAnchor(anchor, document)).toBeNull();
  });

  it('ignores WebMark’s own UI', () => {
    dashboard();
    const target = q('.card:nth-of-type(2)');
    const anchor = createAnchor(target);
    const host = document.createElement('webmark-ui');
    host.innerHTML = card('Users', '1,204 active users');
    target.remove();
    document.body.appendChild(host);

    expect(resolveAnchor(anchor, document)).toBeNull();
    expect(resolveAnchor(withoutLocators(anchor), document)).toBeNull();
  });

  it('does not count WebMark UI text as page text', () => {
    mount('<div id="box">Hello<webmark-ui>Pin #3</webmark-ui></div>');
    expect(createAnchor(q('#box')).text).toBe('Hello');
  });

  it('returns null for an empty or mismatched anchor', () => {
    dashboard();
    const anchor = createAnchor(q('.card'));
    expect(resolveAnchor({ ...anchor, tagName: 'article' }, document)).toBeNull();
    expect(resolveAnchor({ ...anchor, tagName: '' }, document)).toBeNull();
  });

  it('tolerates anchors with missing fields (old or hand-edited imports)', () => {
    dashboard();
    const target = q('.card:nth-of-type(3)');
    const partial = { tagName: 'div', selector: '', xpath: '', text: 'Orders312 orders today' } as unknown as ElementAnchor;
    expect(resolveAnchor(partial, document)?.element).toBe(target);
  });
});

describe('scoreCandidate', () => {
  it('scores the real element above a look-alike and flags contradictions', () => {
    mount(`
      <div class="card" data-testid="a"><h3>Revenue</h3></div>
      <div class="card" data-testid="b"><h3>Users</h3></div>`);
    const [first, second] = Array.from(document.querySelectorAll('.card'));
    const anchor = createAnchor(first!);

    const self = scoreCandidate(anchor, first!);
    const other = scoreCandidate(anchor, second!);
    expect(self.score).toBeGreaterThan(0.9);
    expect(self.exact).toBe(true);
    expect(other.score).toBeLessThan(0.3);
    expect(other.contradictions).toEqual(expect.arrayContaining(['data-testid', 'text']));
  });

  it('treats zero rects as unknown rather than as evidence', () => {
    mount('<p class="intro">Welcome back</p>');
    const anchor = createAnchor(q('p'));
    const moved = { ...anchor, rect: { x: 5000, y: 9000, width: 0, height: 0 } };
    expect(scoreCandidate(moved, q('p')).score).toBeCloseTo(scoreCandidate(anchor, q('p')).score, 5);
  });

  it('uses rect proximity when both rects are known', () => {
    mount('<p class="intro">Welcome back</p>');
    const anchor = createAnchor(q('p'));
    const near = { ...anchor, rect: { x: 0, y: 0, width: 10, height: 10 } };
    const far = { ...anchor, rect: { x: 4000, y: 6000, width: 10, height: 10 } };
    // jsdom has no layout, so give the candidate a rect.
    const p = q('p');
    p.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10, toJSON() {} }) as DOMRect;
    expect(scoreCandidate(near, p).score).toBeGreaterThan(scoreCandidate(far, p).score);
  });

  it('gives zero for a different tag', () => {
    mount('<p>Hi</p><span>Hi</span>');
    expect(scoreCandidate(createAnchor(q('p')), q('span')).score).toBe(0);
  });
});
