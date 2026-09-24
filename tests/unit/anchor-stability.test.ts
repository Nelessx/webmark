import { describe, expect, it } from 'vitest';
import { cssEscapeFallback } from '@/lib/anchor/dom';
import { isStableClass, isStableId, looksGenerated, stableClasses } from '@/lib/anchor';

describe('isStableId', () => {
  it.each([
    ':r1:',
    ':R2d6:',
    '«r1»',
    '_r_1a_',
    'radix-:r2:-trigger',
    'headlessui-menu-button-1',
    'ember123',
    'mui-123',
    'mat-input-0',
    'cdk-overlay-2',
    'rc-tabs-0-panel-1',
    'react-select-3-listbox',
    'input-5',
    'tab-2',
    'item12',
    '3f2b8c1e-9a4d-4b7e-8c2f-1a2b3c4d5e6f',
    'a8f3e2b1c9d0',
    'Xy7kP2qLm9zAbC',
    'comp-l0yrd4ly',
    'section12345',
    '42',
    '1st-place',
  ])('rejects generated id %s', (id) => {
    expect(isStableId(id)).toBe(false);
  });

  it.each(['main', 'header', 'revenue-card', 'save-btn', 'user_profile', 'section2', 'app', '__next', 'h1-title'])(
    'accepts authored id %s',
    (id) => {
      expect(isStableId(id)).toBe(true);
    },
  );

  it('rejects empty, whitespace and very long ids', () => {
    expect(isStableId('')).toBe(false);
    expect(isStableId('a b')).toBe(false);
    expect(isStableId('x'.repeat(80))).toBe(false);
  });
});

describe('isStableClass', () => {
  it.each([
    'Button_primary__3xYz1',
    'styles_card__AbC12',
    '_card_1x2y3_12',
    'sc-bdVaJa',
    'kDSDHk',
    'css-1a2b3c',
    'css-b62m3t-container',
    'jsx-123456',
    'svelte-1xyz2ab',
    'jss12',
    'makeStyles-root-12',
    'Mui-selected',
    'ng-touched',
    'md:flex',
    'w-[32px]',
    'w-1/2',
    '!mt-0',
    'hover:bg-blue-500',
  ])('rejects hashed / utility-variant class %s', (name) => {
    expect(isStableClass(name)).toBe(false);
  });

  it.each([
    'active',
    'hover',
    'focus',
    'focused',
    'open',
    'selected',
    'disabled',
    'is-active',
    'has-error',
    'isOpen',
    'nav__item--active',
    'router-link-active',
    'tab_selected',
  ])('rejects state class %s', (name) => {
    expect(isStableClass(name)).toBe(false);
  });

  it.each(['card', 'revenue-card', 'btn-primary', 'card__title', 'MuiButton-root', 'ProductCard', 'col-md-6', 'mt-4', 'text-gray-500'])(
    'accepts stable class %s',
    (name) => {
      expect(isStableClass(name)).toBe(true);
    },
  );

  it('stableClasses filters and dedupes in document order', () => {
    const el = document.createElement('div');
    el.className = 'card  active Card_x__9fZ2a card revenue-card md:p-4 is-open';
    expect(stableClasses(el)).toEqual(['card', 'revenue-card']);
  });
});

describe('looksGenerated', () => {
  it('flags uuids, React ids and hash tokens but not plain names', () => {
    expect(looksGenerated(':r5:')).toBe(true);
    expect(looksGenerated('field-3f2b8c1e-9a4d-4b7e-8c2f-1a2b3c4d5e6f')).toBe(true);
    expect(looksGenerated('x_a8f3e2b1c9')).toBe(true);
    expect(looksGenerated('email')).toBe(false);
    expect(looksGenerated('user[email]')).toBe(false);
  });
});

describe('cssEscapeFallback', () => {
  it('matches CSS.escape semantics for tricky identifiers', () => {
    expect(cssEscapeFallback('a.b')).toBe('a\\.b');
    expect(cssEscapeFallback('1abc')).toBe('\\31 abc');
    expect(cssEscapeFallback('-')).toBe('\\-');
    expect(cssEscapeFallback('-1')).toBe('-\\31 ');
    expect(cssEscapeFallback('a"b')).toBe('a\\"b');
    expect(cssEscapeFallback('héllo')).toBe('héllo');
  });
});
