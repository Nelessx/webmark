import { describe, expect, it } from 'vitest';
import {
  canRunOn,
  displayPageKey,
  getPageKey,
  isPageUrl,
  isSensitiveParam,
  redactUrl,
  REDACTED,
  sanitizePageKey,
  siteOf,
} from '@/lib/url';

describe('getPageKey', () => {
  it('removes trailing slashes but keeps the root path', () => {
    expect(getPageKey('https://example.com/about/')).toBe('https://example.com/about');
    expect(getPageKey('https://example.com/about///')).toBe('https://example.com/about');
    expect(getPageKey('https://example.com/')).toBe('https://example.com/');
    expect(getPageKey('https://example.com')).toBe('https://example.com/');
  });

  it('lower-cases scheme and host but keeps path case', () => {
    expect(getPageKey('HTTPS://Example.COM/Docs/Intro')).toBe('https://example.com/Docs/Intro');
  });

  it('strips tracking parameters', () => {
    expect(
      getPageKey('https://example.com/pricing?utm_source=news&utm_medium=email&fbclid=abc&gclid=x&msclkid=y'),
    ).toBe('https://example.com/pricing');
    expect(getPageKey('https://example.com/p?UTM_Campaign=spring&_ga=1.2&_gl=3')).toBe('https://example.com/p');
  });

  it('keeps meaningful parameters, sorted so order does not matter', () => {
    const a = getPageKey('https://www.youtube.com/watch?v=abc&t=10&utm_source=x');
    const b = getPageKey('https://www.youtube.com/watch?t=10&v=abc');
    expect(a).toBe('https://www.youtube.com/watch?t=10&v=abc');
    expect(b).toBe(a);
  });

  it('sorts repeated parameters by value and normalises their encoding', () => {
    expect(getPageKey('https://example.com/s?tag=b&tag=a')).toBe('https://example.com/s?tag=a&tag=b');
    expect(getPageKey('https://example.com/s?q=a%20b')).toBe(getPageKey('https://example.com/s?q=a+b'));
  });

  it('drops an empty query string', () => {
    expect(getPageKey('https://example.com/list?')).toBe('https://example.com/list');
  });

  it('keeps hash routes (#/ and #!/) without their trailing slash', () => {
    expect(getPageKey('https://app.example.com/#/dashboard/')).toBe('https://app.example.com/#/dashboard');
    expect(getPageKey('https://app.example.com/#!/settings/profile')).toBe(
      'https://app.example.com/#!/settings/profile',
    );
    expect(getPageKey('https://app.example.com/#/users?tab=2')).toBe('https://app.example.com/#/users?tab=2');
  });

  it('treats a bare "#/" or "#!/" route as the page itself', () => {
    expect(getPageKey('https://app.example.com/#/')).toBe('https://app.example.com/');
    expect(getPageKey('https://app.example.com/#!/')).toBe('https://app.example.com/');
  });

  it('drops plain in-page anchors', () => {
    expect(getPageKey('https://example.com/docs#installation')).toBe('https://example.com/docs');
    expect(getPageKey('https://example.com/docs#')).toBe('https://example.com/docs');
  });

  it('keeps non-default ports and drops default ones', () => {
    expect(getPageKey('http://localhost:3000/app/')).toBe('http://localhost:3000/app');
    expect(getPageKey('https://example.com:8443/x')).toBe('https://example.com:8443/x');
    expect(getPageKey('https://example.com:443/x')).toBe('https://example.com/x');
    expect(getPageKey('http://localhost:3000/')).not.toBe(getPageKey('http://localhost:4000/'));
  });

  it('handles file URLs', () => {
    expect(getPageKey('file:///C:/work/mockup.html')).toBe('file:///C:/work/mockup.html');
  });

  it('returns invalid URLs unchanged', () => {
    expect(getPageKey('not a url')).toBe('not a url');
    expect(getPageKey('')).toBe('');
  });

  it('drops credentials: magic links, OAuth and API tokens, signatures, session ids', () => {
    expect(getPageKey('https://app.example.com/login?token=abc123')).toBe('https://app.example.com/login');
    expect(getPageKey('https://example.com/report?id=5&access_token=x&api_key=y&sig=z')).toBe(
      'https://example.com/report?id=5',
    );
    expect(
      getPageKey(
        'https://bucket.s3.amazonaws.com/a.png?X-Amz-Algorithm=AWS4&X-Amz-Credential=c&X-Amz-Signature=s&X-Amz-Security-Token=t',
      ),
    ).toBe('https://bucket.s3.amazonaws.com/a.png?X-Amz-Algorithm=AWS4');
    expect(getPageKey('https://shop.example.com/cart;jsessionid=A1B2C3?step=2')).toBe('https://shop.example.com/cart?step=2');
    expect(getPageKey('https://example.com/p?PHPSESSID=abc&sid=1&SessionId=2&page=3')).toBe('https://example.com/p?page=3');
  });

  it('drops credentials from hash-route parameters, keeping the route', () => {
    expect(getPageKey('https://app.example.com/#/reset?token=abc')).toBe('https://app.example.com/#/reset');
    expect(getPageKey('https://app.example.com/#!/invite?code=7&secret=x')).toBe('https://app.example.com/#!/invite?code=7');
  });

  it('keeps parameters that name content, and treats credential-free URLs exactly as before', () => {
    expect(getPageKey('https://example.com/item?id=5&v=2&q=shoes&page=3&key=abc&code=XYZ')).toBe(
      'https://example.com/item?code=XYZ&id=5&key=abc&page=3&q=shoes&v=2',
    );
    // Only a parameter named exactly like a credential goes, not one that merely contains the word.
    expect(getPageKey('https://example.com/docs?token_type=bearer&tokens=3&signed=1')).toBe(
      'https://example.com/docs?signed=1&token_type=bearer&tokens=3',
    );
    expect(getPageKey('https://app.example.com/#/users?tab=2')).toBe('https://app.example.com/#/users?tab=2');
    expect(getPageKey('https://example.com/a;v=1/b')).toBe('https://example.com/a;v=1/b');
  });
});

describe('isSensitiveParam', () => {
  it.each(['token', 'TOKEN', 'access_token', 'id-token', 'X-Amz-Signature', 'client_secret', 'jsessionid', 'sid', 'pwd'])(
    'flags %s',
    (name) => expect(isSensitiveParam(name)).toBe(true),
  );

  it.each(['id', 'v', 'q', 'page', 'key', 'code', 'state', 'tab', 'token_type', 'utm_source'])('keeps %s', (name) =>
    expect(isSensitiveParam(name)).toBe(false),
  );
});

describe('redactUrl', () => {
  it('replaces credential values in the query, keeping the rest byte for byte', () => {
    expect(redactUrl('https://example.com/p?b=a%20b&token=abc123&x=1')).toBe(`https://example.com/p?b=a%20b&token=${REDACTED}&x=1`);
    expect(redactUrl('https://example.com/p?Api-Key=k&q=1')).toBe(`https://example.com/p?Api-Key=${REDACTED}&q=1`);
  });

  it('redacts token-bearing fragments', () => {
    expect(redactUrl('https://app.example.com/cb#access_token=ya29.a0&token_type=Bearer&expires_in=3599')).toBe(
      `https://app.example.com/cb#access_token=${REDACTED}&token_type=Bearer&expires_in=3599`,
    );
    expect(redactUrl('https://app.example.com/cb#id_token=eyJ.x.y&state=s1')).toBe(
      `https://app.example.com/cb#id_token=${REDACTED}&state=s1`,
    );
    expect(redactUrl('https://app.example.com/#/reset?token=abc')).toBe(`https://app.example.com/#/reset?token=${REDACTED}`);
  });

  it('redacts a path session id and user:password@', () => {
    expect(redactUrl('https://shop.example.com/cart;jsessionid=A1B2?x=1')).toBe(
      `https://shop.example.com/cart;jsessionid=${REDACTED}?x=1`,
    );
    expect(redactUrl('https://alice:hunter2@example.com/admin')).toBe('https://example.com/admin');
  });

  it('returns URLs without credentials unchanged', () => {
    for (const url of [
      'https://example.com/docs?page=2#section-3',
      'https://example.com/s?q=a+b&tag=x&tag=y',
      'https://app.example.com/#/users?tab=2',
      'file:///C:/work/mockup.html',
      'not a url',
      '',
    ]) {
      expect(redactUrl(url)).toBe(url);
    }
  });
});

describe('sanitizePageKey', () => {
  it('re-keys a page key saved with credentials', () => {
    expect(sanitizePageKey('https://example.com/report?access_token=x&id=5')).toBe('https://example.com/report?id=5');
    expect(sanitizePageKey('https://app.example.com/#/reset?token=abc')).toBe('https://app.example.com/#/reset');
  });

  it('leaves every other page key exactly as it is', () => {
    for (const key of ['https://example.com/', 'https://example.com/s?q=a+b', 'https://app.example.com/#/users?tab=2', 'not a url']) {
      expect(sanitizePageKey(key)).toBe(key);
    }
  });
});

describe('isPageUrl', () => {
  it('accepts http, https and file URLs only', () => {
    expect(isPageUrl('https://example.com/')).toBe(true);
    expect(isPageUrl('http://localhost:3000/x')).toBe(true);
    expect(isPageUrl('file:///C:/a.html')).toBe(true);
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'chrome://settings', 'ftp://example.com/', 'nope', '']) {
      expect(isPageUrl(url)).toBe(false);
    }
  });
});

describe('siteOf / displayPageKey', () => {
  it('returns the host including port', () => {
    expect(siteOf('http://localhost:3000/app')).toBe('localhost:3000');
    expect(siteOf('https://example.com/a?b=1')).toBe('example.com');
  });

  it('falls back to the input when there is no host', () => {
    expect(siteOf('not a url')).toBe('not a url');
  });

  it('strips the protocol for display', () => {
    expect(displayPageKey('https://example.com/a')).toBe('example.com/a');
    expect(displayPageKey('http://localhost:3000/')).toBe('localhost:3000/');
  });
});

describe('canRunOn', () => {
  it.each([
    'https://example.com/',
    'http://localhost:5173/dashboard',
    'file:///C:/work/mockup.html',
    'https://chrome.google.com/search',
    'https://addons.mozilla.org.example.com/',
  ])('allows %s', (url) => {
    expect(canRunOn(url)).toBe(true);
  });

  it.each([
    'chrome://extensions',
    'chrome://newtab/',
    'edge://settings',
    'about:blank',
    'about:addons',
    'chrome-extension://abcdefghijklmnop/popup.html',
    'moz-extension://1234-5678/options.html',
    'view-source:https://example.com/',
    'data:text/html,<p>hi</p>',
    'javascript:alert(1)',
    'ftp://example.com/file',
    'https://chromewebstore.google.com/detail/some-extension/abc',
    'https://CHROMEWEBSTORE.google.com/',
    'https://chrome.google.com/webstore/detail/abc',
    'https://addons.mozilla.org/en-US/firefox/addon/x/',
    'https://microsoftedge.microsoft.com/addons/detail/x',
  ])('blocks %s', (url) => {
    expect(canRunOn(url)).toBe(false);
  });

  it('blocks missing and invalid URLs', () => {
    expect(canRunOn(undefined)).toBe(false);
    expect(canRunOn('')).toBe(false);
    expect(canRunOn('not a url')).toBe(false);
  });
});
