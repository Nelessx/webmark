import { describe, expect, it, vi } from 'vitest';
import { formatRelativeTime, noteToMarkdown, notesToCsv, notesToMarkdownReport, parseTags } from '@/lib/format';
import { NOTE_SCHEMA_VERSION, type Note } from '@/lib/types';

const CREATED = Date.UTC(2026, 2, 3, 14, 5);

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    schemaVersion: NOTE_SCHEMA_VERSION,
    pageKey: 'https://example.com/dashboard',
    url: 'https://example.com/dashboard?utm_source=x',
    pageTitle: 'Dashboard · Acme',
    label: 'Dashboard → Revenue Card',
    body: 'Change this to monthly revenue.\nShow the previous month too.',
    status: 'open',
    tags: ['bug', 'ui'],
    author: 'Alice',
    anchor: {
      selector: 'div.card > h2',
      xpath: '/html/body/div[2]/h2',
      tagName: 'h2',
      classes: ['card-title'],
      attributes: {},
      text: 'Revenue',
      rect: { x: 10, y: 20, width: 300, height: 40 },
      viewport: { width: 1280, height: 800 },
      ancestorTags: ['div', 'body'],
      nthOfType: 1,
    },
    hasScreenshot: false,
    createdAt: CREATED,
    updatedAt: CREATED + 60_000,
    ...overrides,
  };
}

/** Minimal RFC 4180 parser, to check that quoting round-trips. */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && csv[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

// ---------------------------------------------------------------------------

describe('parseTags', () => {
  it('splits on commas', () => {
    expect(parseTags('bug, ui,  Urgent')).toEqual(['bug', 'ui', 'urgent']);
  });

  it('splits whitespace-separated hashtags', () => {
    expect(parseTags('#bug #ui')).toEqual(['bug', 'ui']);
    expect(parseTags('bug #ui #Copy')).toEqual(['bug', 'ui', 'copy']);
  });

  it('turns inner whitespace into hyphens', () => {
    expect(parseTags('needs   review, #Low Priority')).toEqual(['needs-review', 'low-priority']);
  });

  it('keeps a # inside a word', () => {
    expect(parseTags('C# code')).toEqual(['c#-code']);
  });

  it('strips leading hashes, drops empties and de-duplicates', () => {
    expect(parseTags('##bug, , #, Bug, BUG ,,')).toEqual(['bug']);
    expect(parseTags('')).toEqual([]);
    expect(parseTags('   ')).toEqual([]);
  });

  it('accepts the "; " separator the CSV export writes', () => {
    expect(parseTags('bug; ui')).toEqual(['bug', 'ui']);
  });

  it('keeps at most 10 tags', () => {
    const input = Array.from({ length: 15 }, (_, i) => `t${i}`).join(', ');
    expect(parseTags(input)).toEqual(Array.from({ length: 10 }, (_, i) => `t${i}`));
  });

  it('truncates each tag to 32 characters', () => {
    const [tag] = parseTags('a'.repeat(50));
    expect(tag).toBe('a'.repeat(32));
    expect(parseTags(`${'a'.repeat(31)} b`)).toEqual(['a'.repeat(31)]);
  });

  it('does not split emoji when truncating', () => {
    const [tag] = parseTags('😀'.repeat(40));
    expect(Array.from(tag ?? '')).toHaveLength(32);
  });
});

// ---------------------------------------------------------------------------

describe('formatRelativeTime', () => {
  const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
  const ago = (ms: number) => formatRelativeTime(now - ms, now);
  const SEC = 1_000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it('says "just now" for the last 45 seconds', () => {
    expect(ago(0)).toBe('just now');
    expect(ago(44 * SEC)).toBe('just now');
  });

  it('treats a slightly future time (clock skew) as just now', () => {
    expect(ago(-30 * SEC)).toBe('just now');
  });

  it('counts minutes', () => {
    expect(ago(45 * SEC)).toBe('1 min ago');
    expect(ago(5 * MIN)).toBe('5 min ago');
    expect(ago(59 * MIN + 59 * SEC)).toBe('59 min ago');
  });

  it('counts hours', () => {
    expect(ago(HOUR)).toBe('1 h ago');
    expect(ago(23 * HOUR + 59 * MIN)).toBe('23 h ago');
  });

  it('says "yesterday" for 24–48 hours', () => {
    expect(ago(DAY)).toBe('yesterday');
    expect(ago(47 * HOUR)).toBe('yesterday');
  });

  it('counts days for up to a week', () => {
    expect(ago(2 * DAY)).toBe('2 days ago');
    expect(ago(6 * DAY + 23 * HOUR)).toBe('6 days ago');
  });

  it('shows a short date without the year for older dates this year', () => {
    expect(formatRelativeTime(new Date(2026, 5, 8, 9, 0).getTime(), now)).toBe('8 Jun');
    expect(formatRelativeTime(new Date(2026, 0, 1, 0, 0).getTime(), now)).toBe('1 Jan');
  });

  it('includes the year for dates in another year', () => {
    expect(formatRelativeTime(new Date(2025, 2, 3, 12, 0).getTime(), now)).toBe('3 Mar 2025');
  });

  it('shows a date for times well in the future', () => {
    expect(formatRelativeTime(new Date(2027, 2, 3).getTime(), now)).toBe('3 Mar 2027');
  });

  it('returns an empty string for invalid timestamps', () => {
    expect(formatRelativeTime(Number.NaN, now)).toBe('');
    expect(formatRelativeTime(Number.POSITIVE_INFINITY, now)).toBe('');
    expect(formatRelativeTime(1e20, now)).toBe('');
  });

  it('defaults "now" to the current time', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(formatRelativeTime(now - 5 * MIN)).toBe('5 min ago');
  });
});

// ---------------------------------------------------------------------------

describe('noteToMarkdown', () => {
  it('produces an issue-ready block', () => {
    expect(noteToMarkdown(makeNote())).toBe(
      [
        '### [Dashboard → Revenue Card] Change this to monthly revenue.',
        '',
        'Change this to monthly revenue.  ',
        'Show the previous month too.',
        '',
        '- **Page:** [Dashboard · Acme](https://example.com/dashboard?utm_source=x)',
        '- **Status:** Open',
        '- **Tags:** bug, ui',
        '- **Author:** Alice',
        '- **Created:** 2026-03-03 14:05 UTC',
        '',
        '<details>',
        '<summary>Technical details</summary>',
        '',
        '- **Selector:** `div.card > h2`',
        '- **XPath:** `/html/body/div[2]/h2`',
        '',
        '</details>',
        '',
      ].join('\n'),
    );
  });

  it('omits the technical block on request', () => {
    const md = noteToMarkdown(makeNote(), { includeTechnical: false });
    expect(md).not.toContain('<details>');
    expect(md).not.toContain('div.card');
  });

  it('marks resolved notes and omits empty tags and author', () => {
    const md = noteToMarkdown(makeNote({ status: 'resolved', tags: [], author: '' }));
    expect(md).toContain('- **Status:** Resolved');
    expect(md).not.toContain('**Tags:**');
    expect(md).not.toContain('**Author:**');
  });

  it('truncates the heading to 80 characters of the first body line', () => {
    const long = `${'word '.repeat(30).trim()}\nsecond line`;
    const heading = noteToMarkdown(makeNote({ body: long })).split('\n')[0] ?? '';
    const summary = heading.replace('### [Dashboard → Revenue Card] ', '');
    expect(Array.from(summary).length).toBeLessThanOrEqual(80);
    expect(summary.endsWith('…')).toBe(true);
    expect(heading).not.toContain('second line');
  });

  it('uses the first non-empty body line and handles an empty body', () => {
    expect(noteToMarkdown(makeNote({ body: '\n\n  Real text  \nmore' })).split('\n')[0]).toBe(
      '### [Dashboard → Revenue Card] Real text',
    );
    const empty = noteToMarkdown(makeNote({ body: '' }));
    expect(empty.split('\n')[0]).toBe('### [Dashboard → Revenue Card]');
    expect(empty.split('\n')[2]).toBe('- **Page:** [Dashboard · Acme](https://example.com/dashboard?utm_source=x)');
  });

  it('escapes Markdown in the label and page title', () => {
    const md = noteToMarkdown(
      makeNote({
        label: '[Home](javascript:alert(1)) *bold* <img src=x> Card #',
        pageTitle: 'Docs] (x) `code` &amp; _it_\nnext line',
      }),
    );
    const heading = md.split('\n')[0];
    expect(heading).toBe(
      '### [\\[Home\\](javascript:alert(1)) \\*bold\\* \\<img src=x\\> Card \\#] Change this to monthly revenue.',
    );
    expect(md).toContain(
      '- **Page:** [Docs\\] (x) \\`code\\` \\&amp; \\_it\\_ next line](https://example.com/dashboard?utm_source=x)',
    );
  });

  it('escapes Markdown in the heading summary taken from the body', () => {
    const md = noteToMarkdown(makeNote({ body: '**Urgent** fix [this](http://x)' }));
    expect(md.split('\n')[0]).toBe('### [Dashboard → Revenue Card] \\*\\*Urgent\\*\\* fix \\[this\\](http://x)');
  });

  it('keeps the body readable', () => {
    const body = 'Use the *new* logo & fix spacing_here.\n- item one\n- item two';
    const md = noteToMarkdown(makeNote({ body }));
    expect(md).toContain('Use the *new* logo & fix spacing_here.  \n- item one  \n- item two\n');
  });

  it('neutralises raw HTML and comments in the body so they cannot hide the rest', () => {
    const md = noteToMarkdown(makeNote({ body: 'See <!-- this\nand </details> <b>x</b> a < b' }));
    expect(md).toContain('See \\<!-- this  \nand \\</details> \\<b>x\\</b> a < b');
    expect(md).toContain('- **Status:** Open');
  });

  it('closes a code fence left open in the body', () => {
    const md = noteToMarkdown(makeNote({ body: 'Error:\n```js\nthrow new Error("x")' }));
    expect(md).toContain('```js\nthrow new Error("x")\n```\n\n- **Page:**');
  });

  it('does not touch the contents of code fences', () => {
    const body = '````\n```\n<b>raw</b>\n````\nafter';
    const md = noteToMarkdown(makeNote({ body }));
    expect(md).toContain('````\n```\n<b>raw</b>\n````\nafter\n');
  });

  it('uses a code span fence longer than any backticks in the selector', () => {
    const md = noteToMarkdown(
      makeNote({ anchor: { ...makeNote().anchor, selector: 'a[title="``x``"]', xpath: '`start' } }),
    );
    expect(md).toContain('- **Selector:** ```a[title="``x``"]```');
    expect(md).toContain('- **XPath:** `` `start ``');
  });

  it('flattens newlines in code spans', () => {
    const md = noteToMarkdown(makeNote({ anchor: { ...makeNote().anchor, selector: 'div\n> p' } }));
    expect(md).toContain('- **Selector:** `div > p`');
  });

  it('does not link non-web URLs', () => {
    const md = noteToMarkdown(makeNote({ url: 'javascript:alert(1)', pageTitle: 'Evil' }));
    expect(md).toContain('- **Page:** Evil (`javascript:alert(1)`)');
    expect(md).not.toContain('](javascript');
  });

  it('encodes parentheses in link targets', () => {
    const md = noteToMarkdown(makeNote({ url: 'https://en.wikipedia.org/wiki/Foo_(bar)' }));
    expect(md).toContain('(https://en.wikipedia.org/wiki/Foo_%28bar%29)');
  });

  it('falls back to the page key when the page has no title', () => {
    const md = noteToMarkdown(makeNote({ pageTitle: '  ' }));
    expect(md).toContain('- **Page:** [example.com/dashboard](https://example.com/dashboard?utm_source=x)');
  });
});

// ---------------------------------------------------------------------------

describe('notesToMarkdownReport', () => {
  const GENERATED = Date.UTC(2026, 8, 24, 9, 30);

  function reportNotes(): Note[] {
    return [
      makeNote({ id: 'a2', label: 'Header', body: 'Second on dashboard', createdAt: 200, status: 'resolved' }),
      makeNote({
        id: 'b1',
        pageKey: 'http://localhost:3000/',
        url: 'http://localhost:3000/',
        pageTitle: 'Local app',
        label: 'Login button',
        body: 'Make it bigger\nand blue',
        tags: [],
        author: '',
        createdAt: 150,
      }),
      makeNote({ id: 'a1', label: 'Revenue', body: 'First on dashboard', createdAt: 100 }),
      makeNote({
        id: 'c1',
        pageKey: 'https://example.com/about',
        url: 'https://example.com/about',
        pageTitle: 'About',
        body: 'About page note',
        createdAt: 50,
      }),
    ];
  }

  it('starts with a title, date and summary counts', () => {
    vi.spyOn(Date, 'now').mockReturnValue(GENERATED);
    const lines = notesToMarkdownReport(reportNotes()).split('\n');
    expect(lines.slice(0, 5)).toEqual([
      '# WebMark feedback report',
      '',
      'Generated 2026-09-24 09:30 UTC',
      '',
      '**4 notes** · 3 open · 1 resolved',
    ]);
  });

  it('uses a custom, escaped title', () => {
    const md = notesToMarkdownReport([makeNote()], { title: 'Sprint *12* review' });
    expect(md.startsWith('# Sprint \\*12\\* review\n')).toBe(true);
    expect(md).toContain('**1 note** · 1 open · 0 resolved');
  });

  it('groups by site then page, and numbers notes by pin within each page', () => {
    const md = notesToMarkdownReport(reportNotes());
    const order = ['## example.com', '### About', '#1 · Dashboard', '### Dashboard · Acme', '#1 · Revenue', '#2 · Header', '## localhost:3000', '### Local app', '#1 · Login button'];
    const positions = order.map((s) => md.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('renders task-list items with the body and metadata indented under them', () => {
    const md = notesToMarkdownReport(reportNotes());
    expect(md).toContain(
      [
        '- [ ] **#1 · Revenue**',
        '',
        '  First on dashboard',
        '',
        '  _Tags: bug, ui · By Alice · 1970-01-01 00:00 UTC_',
        '',
        '- [x] **#2 · Header**',
      ].join('\n'),
    );
    expect(md).toContain(
      ['- [ ] **#1 · Login button**', '', '  Make it bigger  ', '  and blue', '', '  _1970-01-01 00:00 UTC_'].join('\n'),
    );
  });

  it('links each page under its heading', () => {
    const md = notesToMarkdownReport(reportNotes());
    expect(md).toContain('### Dashboard · Acme\n\n<https://example.com/dashboard?utm_source=x>\n');
  });

  it('uses the newest title for a page', () => {
    const md = notesToMarkdownReport([
      makeNote({ id: 'old', pageTitle: 'Old title', createdAt: 1 }),
      makeNote({ id: 'new', pageTitle: 'New title', createdAt: 2 }),
    ]);
    expect(md).toContain('### New title');
    expect(md).not.toContain('Old title');
  });

  it('groups local files together', () => {
    const md = notesToMarkdownReport([
      makeNote({ id: 'f', pageKey: 'file:///C:/mock/a.html', url: 'file:///C:/mock/a.html', pageTitle: 'Mock A' }),
    ]);
    expect(md).toContain('## Local files');
    expect(md).toContain('<file:///C:/mock/a.html>');
  });

  it('keeps a multi-line fenced body inside its list item', () => {
    const md = notesToMarkdownReport([makeNote({ body: 'Trace:\n```\nat foo()\n```' })]);
    expect(md).toContain('  Trace:\n  ```\n  at foo()\n  ```\n');
  });

  it('handles an empty list', () => {
    const md = notesToMarkdownReport([]);
    expect(md).toContain('**0 notes** · 0 open · 0 resolved');
    expect(md).toContain('_No notes._');
    expect(md.endsWith('\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('notesToCsv', () => {
  const HEADER = 'id,site,page_title,url,label,body,status,tags,author,created_at,updated_at,selector';

  it('writes the header and one CRLF-terminated row per note', () => {
    const csv = notesToCsv([makeNote({ body: 'Simple body' })]);
    expect(csv).toBe(
      `${HEADER}\r\n` +
        'note-1,example.com,Dashboard · Acme,https://example.com/dashboard?utm_source=x,Dashboard → Revenue Card,' +
        'Simple body,open,bug; ui,Alice,2026-03-03T14:05:00.000Z,2026-03-03T14:06:00.000Z,div.card > h2\r\n',
    );
  });

  it('writes only the header for no notes', () => {
    expect(notesToCsv([])).toBe(`${HEADER}\r\n`);
  });

  it('quotes fields with commas, quotes and line breaks', () => {
    const csv = notesToCsv([
      makeNote({ label: 'Card, big', body: 'He said "hi"\r\nthen left\nagain', pageTitle: 'Title "x"' }),
    ]);
    expect(csv).toContain('"Card, big"');
    expect(csv).toContain('"He said ""hi""\r\nthen left\nagain"');
    expect(csv).toContain('"Title ""x"""');
  });

  it('round-trips through an RFC 4180 parser', () => {
    const note = makeNote({ label: 'a,"b"', body: 'line 1\r\nline, 2 "quoted"', tags: ['x', 'y'] });
    const rows = parseCsv(notesToCsv([note]));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.join(',')).toBe(HEADER);
    expect(rows[1]).toEqual([
      'note-1',
      'example.com',
      'Dashboard · Acme',
      'https://example.com/dashboard?utm_source=x',
      'a,"b"',
      'line 1\r\nline, 2 "quoted"',
      'open',
      'x; y',
      'Alice',
      '2026-03-03T14:05:00.000Z',
      '2026-03-03T14:06:00.000Z',
      'div.card > h2',
    ]);
  });

  it.each([
    ['=HYPERLINK("http://evil","x")', `"'=HYPERLINK(""http://evil"",""x"")"`],
    ['+1+1', "'+1+1"],
    ['-2', "'-2"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tcmd', "'\tcmd"],
    ['\rcmd', `"'\rcmd"`],
  ])('guards the formula-like cell %j', (label, expected) => {
    const csv = notesToCsv([makeNote({ label })]);
    const row = csv.split('\r\n')[1] ?? '';
    expect(row).toContain(`,Dashboard · Acme,https://example.com/dashboard?utm_source=x,${expected},`);
  });

  it('guards formula-like values in every user-controlled column', () => {
    const rows = parseCsv(
      notesToCsv([makeNote({ body: '=1+1', author: '@me', pageTitle: '+x', tags: ['-a'] })]),
    );
    const row = rows[1] ?? [];
    expect(row[2]).toBe("'+x");
    expect(row[5]).toBe("'=1+1");
    expect(row[7]).toBe("'-a");
    expect(row[8]).toBe("'@me");
  });

  it('leaves safe values and inner formula characters alone', () => {
    const rows = parseCsv(notesToCsv([makeNote({ body: 'a = b + c - d @ e' })]));
    expect(rows[1]?.[5]).toBe('a = b + c - d @ e');
  });

  it('writes empty timestamps for invalid dates instead of throwing', () => {
    const rows = parseCsv(notesToCsv([makeNote({ createdAt: Number.NaN, updatedAt: 1e20 })]));
    expect(rows[1]?.[9]).toBe('');
    expect(rows[1]?.[10]).toBe('');
  });

  it('uses the host (with port) as the site, and "Local files" for file URLs', () => {
    const rows = parseCsv(
      notesToCsv([
        makeNote({ id: 'a', pageKey: 'http://localhost:3000/app' }),
        makeNote({ id: 'b', pageKey: 'file:///C:/mock.html' }),
      ]),
    );
    expect(rows[1]?.[1]).toBe('localhost:3000');
    expect(rows[2]?.[1]).toBe('Local files');
  });
});
