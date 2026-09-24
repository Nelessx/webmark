import { beforeEach, describe, expect, it } from 'vitest';
import { buildLabel, describeElement } from '@/lib/anchor';

function mount(html: string): void {
  document.body.innerHTML = html;
}

function q(selector: string): Element {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`fixture element ${selector} missing`);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = '';
});

describe('buildLabel', () => {
  it('names a card by its heading and the section by the preceding heading', () => {
    mount(`
      <section>
        <h2>Dashboard</h2>
        <div class="grid">
          <div class="card"><h3>Users</h3><p>1,204</p></div>
          <div class="card" id="t"><h3>Revenue</h3><p>$12,340</p></div>
        </div>
      </section>`);
    expect(buildLabel(q('#t'))).toBe('Dashboard → Revenue card');
  });

  it('does not borrow the heading of a sibling card', () => {
    document.title = 'Reports | Acme';
    mount(`
      <div class="grid">
        <div class="card"><h3>Users</h3></div>
        <div class="card"><button id="t">Export</button></div>
      </div>`);
    expect(buildLabel(q('#t'))).toBe('Reports → Export button');
  });

  it('uses aria-label for a button and the dialog name for the section', () => {
    mount('<div role="dialog" aria-label="Settings"><button id="t" aria-label="Close dialog">×</button></div>');
    expect(buildLabel(q('#t'))).toBe('Settings → Close dialog button');
  });

  it('names an input by its placeholder, never its value', () => {
    document.title = 'Sign up — Acme';
    mount('<form><input id="t" type="email" placeholder="Email" value="alice@example.com"></form>');
    const label = buildLabel(q('#t'));
    expect(label).toBe('Sign up → Email field');
    expect(label).not.toContain('alice');
  });

  it('prefers an associated <label> for form fields', () => {
    mount(`
      <form aria-label="Checkout">
        <label for="country">Country</label>
        <select id="country"><option>Nepal</option><option>India</option></select>
      </form>`);
    expect(buildLabel(q('#country'))).toBe('Checkout → Country dropdown');
  });

  it('falls back to the first segment of document.title', () => {
    document.title = 'Pricing | Acme';
    mount('<button id="t">Buy now</button>');
    expect(buildLabel(q('#t'))).toBe('Pricing → Buy now button');
  });

  it('labels images from alt, and links with a kind', () => {
    mount('<header><a id="home" href="/"><img id="logo" src="/logo.svg" alt="Logo"></a></header><nav aria-label="Main"><a id="docs" href="/docs">Docs</a></nav>');
    expect(buildLabel(q('#logo'))).toBe('Header → Logo image');
    expect(buildLabel(q('#docs'))).toBe('Main → Docs link');
  });

  it('uses aria-labelledby text', () => {
    mount('<h2 id="plan-title">Pro plan</h2><div id="t" class="pricing-card" aria-labelledby="plan-title"><p>$20</p></div>');
    expect(buildLabel(q('#t'))).toBe('Pro plan card');
  });

  it('does not repeat the kind when the name already says it', () => {
    mount('<button id="t">Submit button</button>');
    expect(buildLabel(q('#t'))).toBe('Submit button');
  });

  it('shortens long parts with an ellipsis and keeps the whole label near 80 characters', () => {
    document.title = 'A very long page title that keeps going and going well past forty characters';
    mount(`<p id="t">${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(4)}</p>`);
    const label = buildLabel(q('#t'));
    const parts = label.split(' → ');
    expect(parts).toHaveLength(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(40);
    expect(label.length).toBeLessThanOrEqual(83);
    expect(label).toContain('…');
  });

  it('never returns an empty string', () => {
    mount('<div id="t"></div>');
    expect(buildLabel(q('#t'))).toBe('Element');
    mount('<span id="t"></span>');
    expect(buildLabel(q('#t'))).toBe('Text');
  });

  it('ignores WebMark UI text', () => {
    mount('<p id="t">Hello<webmark-ui>Pin 3</webmark-ui></p>');
    expect(buildLabel(q('#t'))).toBe('Hello');
  });
});

describe('describeElement', () => {
  it('shows tag, stable id and up to two stable classes', () => {
    mount('<button id="save" class="btn-primary active Button_x__3xYz1 wide extra">Save</button>');
    expect(describeElement(q('#save'))).toBe('button#save.btn-primary.wide');
  });

  it('omits generated ids and ranks utility classes last', () => {
    mount('<div id=":r1:" class="mt-4 flex revenue-card">x</div>');
    expect(describeElement(q('div'))).toBe('div.revenue-card.mt-4');
  });

  it('is capped at 48 characters', () => {
    mount('<div id="a-really-long-but-perfectly-stable-identifier" class="another-long-class-name">x</div>');
    const text = describeElement(q('div'));
    expect(text.length).toBeLessThanOrEqual(48);
    expect(text.endsWith('…')).toBe(true);
  });
});
