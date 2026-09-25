import { beforeEach, describe, expect, it } from 'vitest';
import { buildLabel, createAnchor, evaluateXPath, resolveAnchor } from '@/lib/anchor';
import type { ElementAnchor } from '@/lib/types';

/*
 * Wrong-element regressions: a note must never be shown on the wrong element.
 * An orphaned note (null) is acceptable when the real target is gone; when it
 * is still on the page it must be found, not whatever sits at its old position.
 */

function mount(html: string): void {
  document.body.innerHTML = html;
}

function q(selector: string): Element {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`fixture element ${selector} missing`);
  return el;
}

/** Simulate a redeploy that breaks both stored locators, forcing the fuzzy path. */
function withoutLocators(anchor: ElementAnchor): ElementAnchor {
  return { ...anchor, selector: 'div.__gone__', xpath: '/html/body/nothing' };
}

/** The anchor as stored before look-alikes, numbers, hooks and items were recorded. */
function legacy(anchor: ElementAnchor): ElementAnchor {
  const { lookAlikes: _lookAlikes, shapeUnique: _shapeUnique, uniqueHooks: _uniqueHooks, item: _item, ...stored } = anchor;
  return stored;
}

function byText(selector: string, text: string): Element {
  const el = Array.from(document.querySelectorAll(selector)).find((node) => node.textContent === text);
  if (!el) throw new Error(`no ${selector} reading "${text}"`);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = '';
});

describe('repeated controls: look-alikes are told apart by their card or row', () => {
  const product = (title: string) =>
    `<div class="product"><h3>${title}</h3><p>Nice</p><button class="btn buy">Add to cart</button></div>`;
  const shop = (titles: string[]) => mount(`<div id="list">${titles.map(product).join('')}</div>`);
  const buttonIn = (title: string) => byText('h3', title).parentElement!.querySelector('button')!;
  const cardOf = (el: Element | undefined) => el?.closest('.product')?.querySelector('h3')?.textContent;

  it('records the look-alikes and the card that tells them apart', () => {
    shop(['Blue Shirt', 'Red Hat', 'Green Scarf']);
    const anchor = createAnchor(buttonIn('Red Hat'));
    expect(anchor.lookAlikes).toBe(2);
    expect(anchor.item).toMatchObject({ depth: 1, shapeUnique: true });
    expect(anchor.item?.text).toContain('red hat');
  });

  it('finds the button on an unchanged page', () => {
    shop(['Blue Shirt', 'Red Hat', 'Green Scarf']);
    const target = buttonIn('Red Hat');
    const result = resolveAnchor(createAnchor(target), document);
    expect(result?.element).toBe(target);
    expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('returns null, not the next card’s button, when its card is removed in place', () => {
    shop(['Blue Shirt', 'Red Hat', 'Green Scarf']);
    const target = buttonIn('Red Hat');
    const anchor = createAnchor(target);
    target.parentElement!.remove();
    // The stored XPath now points at Green Scarf's identical button.
    expect(evaluateXPath(anchor.xpath, document)).toBe(buttonIn('Green Scarf'));
    expect(resolveAnchor(anchor, document)).toBeNull();
  });

  it('returns null when the list is re-rendered without the card', () => {
    shop(['Blue Shirt', 'Red Hat', 'Green Scarf']);
    const anchor = createAnchor(buttonIn('Red Hat'));
    shop(['Blue Shirt', 'Green Scarf']);
    expect(resolveAnchor(anchor, document)).toBeNull();
  });

  it('never falls back to the only other button left', () => {
    shop(['Blue Shirt', 'Red Hat']);
    const anchor = createAnchor(buttonIn('Red Hat'));
    shop(['Blue Shirt']);
    expect(resolveAnchor(anchor, document)).toBeNull();
    expect(resolveAnchor(withoutLocators(anchor), document)).toBeNull();
  });

  it('follows its card when the list is re-sorted', () => {
    shop(['Blue Shirt', 'Red Hat', 'Green Scarf']);
    const anchor = createAnchor(buttonIn('Red Hat'));
    shop(['Green Scarf', 'Blue Shirt', 'Red Hat']);
    // The stored position now holds Blue Shirt's identical button.
    expect(cardOf(document.querySelector(anchor.selector) ?? undefined)).toBe('Blue Shirt');
    const result = resolveAnchor(anchor, document);
    expect(result?.element).toBe(buttonIn('Red Hat'));
    expect(cardOf(result?.element)).toBe('Red Hat');
  });

  it('follows its card by the card alone when the locators are gone', () => {
    shop(['Blue Shirt', 'Red Hat', 'Green Scarf']);
    const anchor = withoutLocators(createAnchor(buttonIn('Red Hat')));
    shop(['Green Scarf', 'Red Hat', 'Blue Shirt']);
    const result = resolveAnchor(anchor, document);
    expect(result?.element).toBe(buttonIn('Red Hat'));
    expect(result?.method).toBe('fuzzy');
  });

  it('follows its card when the card’s price changed and a wrapper was added', () => {
    const priced = (title: string, price: string, wrap = false) => {
      const button = '<button class="btn buy">Add to cart</button>';
      return `<div class="product"><h3>${title}</h3><p>$${price}</p>${wrap ? `<div class="actions">${button}</div>` : button}</div>`;
    };
    mount(`<div id="list">${priced('Blue Shirt', '20')}${priced('Red Hat', '15')}${priced('Green Scarf', '9')}</div>`);
    const anchor = createAnchor(buttonIn('Red Hat'));
    mount(`<div id="list">${priced('Green Scarf', '9', true)}${priced('Red Hat', '12', true)}${priced('Blue Shirt', '20', true)}</div>`);
    expect(cardOf(resolveAnchor(anchor, document)?.element)).toBe('Red Hat');
  });

  describe('an "Edit" link in a table row', () => {
    const table = (names: string[]) =>
      mount(`<table><tbody>${names.map((n) => `<tr><td>${n}</td><td><a href="#" class="edit">Edit</a></td></tr>`).join('')}</tbody></table>`);
    const linkIn = (name: string) => byText('td', name).parentElement!.querySelector('a')!;

    it('records the row as the item', () => {
      table(['Alice', 'Bob', 'Carol']);
      const anchor = createAnchor(linkIn('Bob'));
      expect(anchor.lookAlikes).toBe(2);
      expect(anchor.item).toMatchObject({ depth: 2, text: 'bobedit' });
    });

    it('follows the row when the table is re-sorted', () => {
      table(['Alice', 'Bob', 'Carol']);
      const anchor = createAnchor(linkIn('Bob'));
      table(['Carol', 'Alice', 'Bob']);
      expect(document.querySelector(anchor.selector)).toBe(linkIn('Alice'));
      expect(resolveAnchor(anchor, document)?.element).toBe(linkIn('Bob'));
    });

    it('returns null when the row is gone', () => {
      table(['Alice', 'Bob', 'Carol']);
      const anchor = createAnchor(linkIn('Bob'));
      table(['Alice', 'Carol']);
      expect(resolveAnchor(anchor, document)).toBeNull();
      table(['Carol']);
      expect(resolveAnchor(anchor, document)).toBeNull();
    });

    it('knows the row by its unique test id even when its text changed', () => {
      const keyed = (rows: [string, string][]) =>
        mount(
          `<table><tbody>${rows
            .map(([key, name]) => `<tr data-testid="row-${key}"><td>${name}</td><td><a href="#" class="edit">Edit</a></td></tr>`)
            .join('')}</tbody></table>`,
        );
      keyed([['alice', 'Alice'], ['bob', 'Bob'], ['carol', 'Carol']]);
      const anchor = createAnchor(linkIn('Bob'));
      expect(anchor.item?.testId).toEqual({ name: 'data-testid', value: 'row-bob' });
      keyed([['carol', 'Carol'], ['bob', 'Robert (Bob)'], ['alice', 'Alice']]);
      expect(resolveAnchor(anchor, document)?.element).toBe(linkIn('Robert (Bob)'));
      keyed([['carol', 'Carol'], ['alice', 'Bob']]);
      expect(resolveAnchor(anchor, document)).toBeNull();
    });
  });

  describe('the same call to action in the header and the footer', () => {
    const page = (footer: string) =>
      mount(`
        <header><a class="cta" href="/signup">Sign up</a><nav>Home Pricing</nav></header>
        <main><h1>Welcome</h1></main>
        <footer>${footer}</footer>`);
    const footerCta = () => q('footer a.cta');

    it('keeps a structural selector hit when the footer’s other text changes', () => {
      page('<p>© Acme</p><a class="cta" href="/signup">Sign up</a>');
      const anchor = createAnchor(footerCta());
      expect(anchor.selector).toBe('footer > a.cta');
      expect(anchor.lookAlikes).toBe(1);
      page('<p>© Acme · Careers · Press</p><a class="cta" href="/signup">Sign up</a>');
      expect(resolveAnchor(anchor, document)?.element).toBe(footerCta());
    });

    it('returns null, not the header’s, once the footer’s is gone', () => {
      page('<p>© Acme</p><a class="cta" href="/signup">Sign up</a>');
      const anchor = createAnchor(footerCta());
      page('<p>© Acme</p>');
      expect(resolveAnchor(anchor, document)).toBeNull();
    });
  });

  describe('identical widgets nothing but position tells apart', () => {
    const widgets = (count: number) =>
      mount(Array.from({ length: count }, () => '<section><div class="w"><button class="go">Go</button></div></section>').join(''));

    it('trusts the position while all of them are still there', () => {
      widgets(3);
      const target = document.querySelectorAll('button')[1]!;
      const anchor = createAnchor(target);
      expect(anchor.lookAlikes).toBe(2);
      expect(anchor.item).toBeUndefined();
      expect(resolveAnchor(anchor, document)?.element).toBe(target);
    });

    it('returns null once one of them is gone: it can’t know which', () => {
      widgets(3);
      const all = Array.from(document.querySelectorAll('section'));
      const anchor = createAnchor(all[1]!.querySelector('button')!);
      all[1]!.remove();
      expect(resolveAnchor(anchor, document)).toBeNull();
      expect(resolveAnchor(withoutLocators(anchor), document)).toBeNull();
    });
  });

  describe('legacy anchors (no item recorded): null while more than one look-alike exists', () => {
    it('never returns another card’s button', () => {
      shop(['Blue Shirt', 'Red Hat', 'Green Scarf']);
      const anchor = legacy(createAnchor(buttonIn('Red Hat')));
      shop(['Green Scarf', 'Blue Shirt', 'Red Hat']);
      expect(resolveAnchor(anchor, document)).toBeNull();
      shop(['Blue Shirt', 'Green Scarf']);
      expect(resolveAnchor(anchor, document)).toBeNull();
      // Even unchanged: identical buttons at the stored position can't be told apart without the item.
      shop(['Blue Shirt', 'Red Hat', 'Green Scarf']);
      expect(resolveAnchor(anchor, document)).toBeNull();
    });

    it('still resolves an element whose content is unique', () => {
      shop(['Blue Shirt', 'Red Hat', 'Green Scarf']);
      const target = byText('h3', 'Red Hat');
      const anchor = legacy(createAnchor(target));
      expect(resolveAnchor(anchor, document)?.element).toBe(target);
      q('#list').insertAdjacentHTML('afterbegin', product('Yellow Cap'));
      expect(resolveAnchor(anchor, document)?.element).toBe(target);
    });
  });
});

describe('ids and test ids only count as identity when they were unique', () => {
  const cards = (items: [string, string][]) =>
    mount(
      `<div id="list">${items
        .map(([title, price]) => `<div class="card" data-testid="product-card"><h3>${title}</h3><p>${price}</p></div>`)
        .join('')}</div>`,
    );

  it('records which hooks were unique', () => {
    mount(`
      <div id="kpi-revenue" data-testid="kpi-revenue" data-cy="card" class="kpi">Revenue</div>
      <div class="kpi" data-cy="card">Users</div>`);
    expect(createAnchor(q('#kpi-revenue')).uniqueHooks).toEqual(['id', 'data-testid']);
  });

  it('does not return the other card when the one sharing its test id is removed', () => {
    cards([['Blue Shirt', '$20'], ['Red Hat', '$15']]);
    const target = q('.card');
    const anchor = createAnchor(target);
    expect(anchor.uniqueHooks).toEqual([]);
    target.remove();
    expect(resolveAnchor(anchor, document)).toBeNull();
    expect(resolveAnchor(withoutLocators(anchor), document)).toBeNull();
  });

  it('does not carry a rewritten card on a shared test id', () => {
    cards([['Blue Shirt', '$20'], ['Red Hat', '$15']]);
    const target = q('.card');
    const anchor = createAnchor(target);
    target.innerHTML = '<h3>Loading</h3><p>Please wait</p>';
    expect(resolveAnchor(anchor, document)).toBeNull();
  });

  it('still carries a rewritten element on a unique test id', () => {
    mount('<div class="kpi" data-testid="kpi-revenue">Revenue $1</div><div class="kpi" data-testid="kpi-users">Users 5</div>');
    const target = q('[data-testid="kpi-revenue"]');
    const anchor = createAnchor(target);
    target.textContent = 'Loading…';
    expect(resolveAnchor(anchor, document)?.element).toBe(target);
  });

  it('legacy anchors count a test id only when it was the whole selector', () => {
    mount('<div class="kpi" data-testid="kpi-revenue">Revenue $1</div><div class="kpi" data-testid="kpi-users">Users 5</div>');
    const unique = q('[data-testid="kpi-revenue"]');
    const uniqueAnchor = legacy(createAnchor(unique));
    expect(uniqueAnchor.selector).toBe('[data-testid="kpi-revenue"]');
    unique.textContent = 'Loading…';
    expect(resolveAnchor(uniqueAnchor, document)?.element).toBe(unique);

    cards([['Blue Shirt', '$20'], ['Red Hat', '$15']]);
    const shared = q('.card');
    const sharedAnchor = legacy(createAnchor(shared));
    shared.remove();
    expect(resolveAnchor(sharedAnchor, document)).toBeNull();
  });
});

describe('numbers identify look-alikes that differ only in their numbers', () => {
  it('returns null, not the other invoice, when an invoice is removed', () => {
    mount('<ul class="invoices"><li class="invoice">Invoice 2024-001 due</li><li class="invoice">Invoice 2024-002 due</li></ul>');
    const target = q('li:nth-of-type(2)');
    const anchor = createAnchor(target);
    expect(anchor.shapeUnique).toBe(false);
    target.remove();
    expect(resolveAnchor(anchor, document)).toBeNull();
  });

  it('returns null, not the last order left, when an order is removed', () => {
    const orders = (ids: number[]) =>
      mount(`<div id="orders">${ids.map((id) => `<div class="order"><h3>Order #${id}</h3><p>Shipped</p></div>`).join('')}</div>`);
    orders([1001, 1002]);
    const anchor = createAnchor(q('.order:nth-of-type(2)'));
    orders([1001]);
    expect(resolveAnchor(anchor, document)).toBeNull();
    orders([1001, 1003]);
    expect(resolveAnchor(anchor, document)).toBeNull();
  });

  const kpis = (revenue: string) =>
    mount(`
      <div class="kpis">
        <div class="kpi"><h3>Revenue</h3><p>${revenue}</p></div>
        <div class="kpi"><h3>Users</h3><p>1,204</p></div>
        <div class="kpi"><h3>Orders</h3><p>312</p></div>
      </div>`);

  it('still follows a KPI card whose value changed', () => {
    kpis('$48,210');
    const target = q('.kpi');
    const anchor = createAnchor(target);
    expect(anchor.shapeUnique).toBe(true);
    target.querySelector('p')!.textContent = '$48,305';
    expect(resolveAnchor(anchor, document)?.element).toBe(target);
    q('.kpis').insertAdjacentHTML('afterbegin', '<div class="kpi"><h3>Churn</h3><p>2.1%</p></div>');
    expect(resolveAnchor(anchor, document)?.element).toBe(target);
    expect(resolveAnchor(withoutLocators(anchor), document)?.element).toBe(target);
  });

  it('follows a changing number when its row tells it apart', () => {
    const tickers = (rows: [string, string][]) =>
      mount(`<table><tbody>${rows.map(([name, price]) => `<tr><td>${name}</td><td class="price">${price}</td></tr>`).join('')}</tbody></table>`);
    tickers([['AAPL', '189.23'], ['MSFT', '402.11']]);
    const anchor = createAnchor(q('.price'));
    expect(anchor).toMatchObject({ shapeUnique: false, item: { depth: 1, shapeUnique: true } });

    tickers([['MSFT', '402.50'], ['AAPL', '189.40']]);
    expect(resolveAnchor(anchor, document)?.element).toBe(byText('td', '189.40'));
    tickers([['MSFT', '402.50']]);
    expect(resolveAnchor(anchor, document)).toBeNull();
  });

  describe('legacy anchors (numbers not classified)', () => {
    it('still follow a KPI card whose value changed', () => {
      kpis('$48,210');
      const target = q('.kpi');
      const anchor = legacy(createAnchor(target));
      target.querySelector('p')!.textContent = '$48,305';
      expect(resolveAnchor(withoutLocators(anchor), document)?.element).toBe(target);
    });

    it('treat numbers as identity while other elements read the same up to them', () => {
      const orders = (ids: number[]) =>
        mount(`<div id="orders">${ids.map((id) => `<div class="order"><h3>Order #${id}</h3><p>Shipped</p></div>`).join('')}</div>`);
      orders([1001, 1002, 2999]);
      const anchor = legacy(createAnchor(q('.order:nth-of-type(2)')));
      orders([1003, 2999]);
      expect(resolveAnchor(anchor, document)).toBeNull();
    });
  });
});

describe('still holds for new and legacy anchors', () => {
  const card = (title: string, body: string, attrs = 'class="card"') => `<div ${attrs}><h3>${title}</h3><p>${body}</p></div>`;
  const dashboard = () =>
    mount(`
      <main id="dashboard">
        <div class="cards">
          ${card('Revenue', 'Monthly revenue $12,340')}
          ${card('Users', '1,204 active users')}
          ${card('Orders', '312 orders today')}
        </div>
      </main>`);

  describe.each([
    ['new', (anchor: ElementAnchor) => anchor],
    ['legacy', legacy],
  ])('%s anchors', (_kind, stored) => {
    it('survive a sibling inserted before the target', () => {
      dashboard();
      const target = q('.card:nth-of-type(2)');
      const anchor = stored(createAnchor(target));
      q('.cards').insertAdjacentHTML('afterbegin', card('Churn', '2.1% monthly churn'));
      expect(resolveAnchor(anchor, document)?.element).toBe(target);
    });

    it('survive hashed class renames', () => {
      mount(`<div class="cards">${card('Revenue', '$12,340', 'class="card revenue-card"')}${card('Users', '1,204 active users', 'class="card users-card"')}</div>`);
      const target = q('.users-card');
      const anchor = stored(createAnchor(target));
      for (const el of Array.from(document.querySelectorAll('.card'))) el.className = 'Card_card__3xYz1';
      q('.cards').insertAdjacentHTML('afterbegin', '<div class="Card_card__3xYz1"><h3>Churn</h3><p>2.1%</p></div>');
      expect(resolveAnchor(anchor, document)?.element).toBe(target);
    });

    it('survive a slightly edited text', () => {
      dashboard();
      const target = q('.card:nth-of-type(2)');
      const anchor = stored(createAnchor(target));
      target.querySelector('p')!.textContent = '1,204 active users this week';
      expect(resolveAnchor(anchor, document)?.element).toBe(target);
    });

    it('follow an element moved elsewhere with the same test id', () => {
      mount(`
        <section id="top"><div class="kpi" data-testid="kpi-revenue">Revenue $1</div><div class="kpi" data-testid="kpi-users">Users 5</div></section>
        <section id="bottom"><div class="kpi" data-testid="kpi-orders">Orders 9</div></section>`);
      const target = q('[data-testid="kpi-revenue"]');
      const anchor = stored(createAnchor(target));
      q('#bottom').appendChild(target);
      expect(resolveAnchor(anchor, document)?.element).toBe(target);
    });

    it('pick the right card among twenty that differ by text, and none once it is gone', () => {
      const all = Array.from({ length: 20 }, (_, i) => i + 1);
      const products = (order: number[]) =>
        mount(`<div id="list">${order.map((n) => card(`Product ${n}`, `Price $${n * 10}`)).join('')}</div>`);
      products(all);
      const anchor = stored(createAnchor(byText('h3', 'Product 7').parentElement!));
      products([...all].reverse());
      expect(resolveAnchor(anchor, document)?.element).toBe(byText('h3', 'Product 7').parentElement);
      products(all.filter((n) => n !== 7));
      expect(resolveAnchor(anchor, document)).toBeNull();
    });
  });
});

describe('labels never contain typed text', () => {
  it('names an editable region by its authored hints only', () => {
    document.title = 'Compose | Mail';
    mount('<div id="t" contenteditable="true" aria-label="Message body">Dear Bob, my password is hunter2</div>');
    expect(buildLabel(q('#t'))).toBe('Compose → Message body field');

    mount('<div id="t" contenteditable="true">Dear Bob, my password is hunter2</div>');
    expect(buildLabel(q('#t'))).toBe('Compose → Field');
  });

  it('never reads typed text inside an editor, including its headings', () => {
    mount(`
      <section aria-label="Notes">
        <div contenteditable="true">
          <h2>Private plans</h2>
          <p id="t">Quit on Friday</p>
        </div>
        <div role="textbox" id="box">typed secret</div>
        <div class="card"><div contenteditable="plaintext-only">drafted secret</div></div>
      </section>`);
    const labels = [buildLabel(q('#t')), buildLabel(q('#box')), buildLabel(q('.card'))].join(' | ');
    expect(labels).not.toMatch(/private|quit|secret/i);
    expect(buildLabel(q('#t'))).toBe('Notes → Paragraph');
  });

  it('never stores typed text in an anchor’s item', () => {
    mount(`
      <div contenteditable="true">
        <ul><li>Secret one <b>Keep</b></li><li>Secret two <b>Keep</b></li></ul>
      </div>`);
    const anchor = createAnchor(document.querySelectorAll('b')[1]!);
    expect(JSON.stringify(anchor)).not.toMatch(/secret/i);
  });
});
