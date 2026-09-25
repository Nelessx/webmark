// Must stay the first import: it runs before React DOM loads (see the file).
import { isHtmlDocument } from './xmlDocumentGuard';
import { createRoot, type Root } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import { createShadowRootUi, type ShadowRootContentScriptUi } from 'wxt/utils/content-script-ui/shadow-root';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { setWebmarkHost, WEBMARK_HOST_ATTR, WEBMARK_HOST_TAG } from '@/lib/constants';
import { promoteToTopLayer, raiseInTopLayer } from '@/lib/topLayer';
import { getPageKey } from '@/lib/url';
import { App } from './components/App';
import { WebmarkContext } from './components/context';
import { Controller } from './controller';
import { keepHostAttached } from './hostKeeper';
import { LayoutTracker } from './layout';
import { registerMessageHandlers } from './messaging';
import { ModalHost } from './modalHost';
import { createAppStore } from './store';
import './style.css';

/** Marker on this isolated world's global object: the instance that currently owns the page UI. */
const INSTANCE_KEY = '__webmarkContentInstance';

interface Instance {
  isLive(): boolean;
}

type InstanceGlobal = typeof globalThis & { [INSTANCE_KEY]?: Instance };

/**
 * The background re-injects this script into already-open tabs after
 * install/update. Returns false if a live instance already runs in this
 * world; otherwise claims the page and removes UI left behind by an
 * invalidated (orphaned) instance.
 */
function claimPage(ctx: ContentScriptContext): boolean {
  const global = globalThis as InstanceGlobal;
  if (global[INSTANCE_KEY]?.isLive()) return false;
  document.querySelectorAll(`${WEBMARK_HOST_TAG}, [${WEBMARK_HOST_ATTR}]`).forEach((el) => el.remove());
  const instance: Instance = { isLive: () => ctx.isValid };
  global[INSTANCE_KEY] = instance;
  ctx.onInvalidated(() => {
    if (global[INSTANCE_KEY] === instance) delete global[INSTANCE_KEY];
  });
  return true;
}

/**
 * WXT stops a running content script when a newer one with the same name
 * announces itself with an event on `document`. The event's name holds only
 * the extension id, which is public for store installs, so a page could send
 * it and switch WebMark off. A live instance never yields to a newcomer anyway
 * (claimPage makes the newcomer step aside), so the event is dropped while
 * ours is live; an orphaned instance, whose runtime is gone, still gets it.
 */
function ignoreRestartAnnouncements(ctx: ContentScriptContext): void {
  // `wxt dev` reloads content scripts this way.
  if (import.meta.env.COMMAND === 'serve') return;
  // Public at runtime, private in WXT's typings.
  const type = (ContentScriptContext as unknown as { SCRIPT_STARTED_MESSAGE_TYPE?: unknown }).SCRIPT_STARTED_MESSAGE_TYPE;
  if (typeof type !== 'string') return;
  window.addEventListener(
    type,
    (event) => {
      if (browser.runtime?.id) event.stopImmediatePropagation();
    },
    { capture: true, signal: ctx.signal },
  );
}

/**
 * Input inside WebMark's UI must not bubble out to the page: keystrokes would
 * trigger page shortcuts, handlers that preventDefault() on mousedown/click
 * (canvas apps, custom menus) would break our controls, document paste
 * handlers could read or cancel a paste, and focus traps would pull focus
 * back into the page. isolateEvents covers keys at the shadow root; this
 * covers the rest. Capture-phase listeners (ours, the picker's, and the
 * page's) still see everything, retargeted to the host: only the isolated
 * editor frame keeps what is typed out of the page entirely.
 */
const ISOLATED_EVENTS = [
  'keydown',
  'keyup',
  'keypress',
  'beforeinput',
  'input',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'paste',
  'copy',
  'cut',
  'focusin',
  'focusout',
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'auxclick',
  'dblclick',
  'contextmenu',
  'wheel',
  'touchstart',
  'touchend',
  'dragenter',
  'dragover',
  'drop',
];

function isolateInput(el: HTMLElement): void {
  for (const type of ISOLATED_EVENTS) {
    el.addEventListener(type, (event) => event.stopPropagation(), { passive: true });
  }
}

interface Mounted {
  root: Root;
  appRoot: HTMLDivElement;
  pickerLayer: HTMLDivElement;
}

type Ui = ShadowRootContentScriptUi<Mounted>;

function createUi(ctx: ContentScriptContext, name: string): Promise<Ui> {
  return createShadowRootUi<Mounted>(ctx, {
    name,
    position: 'inline',
    anchor: () => document.body ?? document.documentElement,
    append: 'last',
    // Closed so page scripts can't read notes shown in our UI; tests need it open.
    mode: import.meta.env.MODE === 'test' || import.meta.env.MODE === 'e2e' ? 'open' : 'closed',
    isolateEvents: true,
    onMount(container) {
      container.className = 'wm-container';
      isolateInput(container);
      const appRoot = document.createElement('div');
      appRoot.className = 'wm-app-root';
      const pickerLayer = document.createElement('div');
      pickerLayer.className = 'wm-picker-layer';
      pickerLayer.setAttribute('data-wm-picker-layer', '');
      container.append(appRoot, pickerLayer);
      return { root: createRoot(appRoot), appRoot, pickerLayer };
    },
    onRemove(mounted) {
      mounted?.root.unmount();
    },
  });
}

/** A custom element name the page can't have defined in advance. */
function randomHostTag(): string {
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join('');
  return `${WEBMARK_HOST_TAG}-${suffix}`;
}

/** True if the page registered our tag as a custom element: its constructor then ran on our host. */
function definedByPage(host: Element): boolean {
  try {
    return host.matches(':defined');
  } catch {
    return false;
  }
}

/**
 * Create the shadow host. A page that defined <webmark-ui> before we got here
 * runs its constructor on our host and can keep attachInternals(), whose
 * shadowRoot exposes even a closed root. Nothing but our CSS is in the root at
 * that point, so start over under a random name the page can't have defined.
 */
async function createHost(ctx: ContentScriptContext): Promise<Ui> {
  const ui = await createUi(ctx, WEBMARK_HOST_TAG).catch(() => undefined);
  if (ui && !definedByPage(ui.shadowHost)) return ui;
  ui?.remove();
  return createUi(ctx, randomHostTag());
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  cssInjectionMode: 'ui',
  // WXT's "script started" handshake would also be posted to the page's window, extension id included.
  noScriptStartedPostMessage: true,

  async main(ctx) {
    if (window.top !== window) return;
    // SVG/XML documents (feeds, Chrome's XML viewer) can't host a custom-element shadow root.
    if (!isHtmlDocument(document) || !(document.documentElement instanceof HTMLElement)) return;
    if (!claimPage(ctx)) return;
    ignoreRestartAnnouncements(ctx);

    const store = createAppStore(getPageKey(location.href));
    const layout = new LayoutTracker(ctx);

    const ui = await createHost(ctx);
    if (ctx.isInvalid) return;
    const host = ui.shadowHost;
    host.setAttribute(WEBMARK_HOST_ATTR, '');
    setWebmarkHost(host);
    ctx.onInvalidated(() => setWebmarkHost(null));

    ui.mount();
    const mounted = ui.mounted;
    if (!mounted) return;
    // In the top layer a transformed <html>/<body> can't capture our fixed UI;
    // elsewhere the layout tracker measures the offset and App undoes it.
    promoteToTopLayer(mounted.appRoot);
    layout.setOriginElement(mounted.appRoot);
    const modalHost = new ModalHost(ctx, store, host, () => {
      // Re-showing the layer blurs what had focus in it (the editor frame, say).
      const focused = ui.shadow.activeElement;
      raiseInTopLayer(mounted.appRoot);
      if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    });
    keepHostAttached(ctx, host, () => {
      promoteToTopLayer(mounted.appRoot);
      modalHost.update();
    });

    const controller = new Controller({
      ctx,
      store,
      layout,
      host,
      shadowRoot: ui.shadow,
      uiContainer: ui.uiContainer,
      pickerLayer: mounted.pickerLayer,
    });
    registerMessageHandlers(ctx, controller);

    mounted.root.render(
      <WebmarkContext.Provider value={{ store, layout, actions: controller }}>
        <App />
      </WebmarkContext.Provider>,
    );
    controller.start();
  },
});
