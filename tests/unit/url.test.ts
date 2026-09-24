import { describe, expect, it } from 'vitest';
import { canRunOn, displayPageKey, getPageKey, siteOf } from '@/lib/url';

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
