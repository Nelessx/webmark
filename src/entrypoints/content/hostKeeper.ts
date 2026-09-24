import type { ContentScriptContext } from 'wxt/utils/content-script-context';

const MAX_REATTACH = 50;

/**
 * Re-attach the shadow host if the page removes it, e.g. Turbo/pjax replacing
 * the whole <body> on navigation or a framework re-rendering body's children.
 * Only direct children of <html> and <body> are observed, so this is cheap.
 */
export function keepHostAttached(ctx: ContentScriptContext, host: HTMLElement): void {
  let body = document.body;
  let reattached = 0;

  const observe = () => {
    observer.disconnect();
    observer.observe(document.documentElement, { childList: true });
    if (body) observer.observe(body, { childList: true });
  };

  const observer = new MutationObserver(() => {
    if (ctx.isInvalid) return;
    if (document.body !== body) {
      body = document.body;
      observe();
    }
    // Give up rather than fight a page that keeps removing us.
    if (!host.isConnected && reattached < MAX_REATTACH) {
      reattached++;
      (document.body ?? document.documentElement).append(host);
    }
  });

  observe();
  ctx.onInvalidated(() => observer.disconnect());
}
