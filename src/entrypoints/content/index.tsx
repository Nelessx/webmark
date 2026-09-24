import { createRoot, type Root } from 'react-dom/client';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { WEBMARK_HOST_TAG } from '@/lib/constants';
import { getPageKey } from '@/lib/url';
import { App } from './components/App';
import { WebmarkContext } from './components/context';
import { Controller } from './controller';
import { keepHostAttached } from './hostKeeper';
import { LayoutTracker } from './layout';
import { registerMessageHandlers } from './messaging';
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
  document.querySelectorAll(WEBMARK_HOST_TAG).forEach((el) => el.remove());
  const instance: Instance = { isLive: () => ctx.isValid };
  global[INSTANCE_KEY] = instance;
  ctx.onInvalidated(() => {
    if (global[INSTANCE_KEY] === instance) delete global[INSTANCE_KEY];
  });
  return true;
}

/**
 * Input inside WebMark's UI must not bubble out to the page: keystrokes would
 * trigger page shortcuts, and page handlers that preventDefault() on
 * mousedown/click (canvas apps, custom menus) would break our controls.
 * isolateEvents covers keys at the shadow root; this also covers pointer input.
 * Capture-phase listeners (ours and the picker's) still see everything.
 */
const ISOLATED_EVENTS = [
  'keydown',
  'keyup',
  'keypress',
  'beforeinput',
  'input',
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'contextmenu',
  'wheel',
];

function isolateInput(el: HTMLElement): void {
  for (const type of ISOLATED_EVENTS) {
    el.addEventListener(type, (event) => event.stopPropagation(), { passive: true });
  }
}

interface Mounted {
  root: Root;
  pickerLayer: HTMLDivElement;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  cssInjectionMode: 'ui',

  async main(ctx) {
    if (window.top !== window) return;
    // SVG/XML documents can't host a custom-element shadow root.
    if (!(document.documentElement instanceof HTMLElement)) return;
    if (!claimPage(ctx)) return;

    const store = createAppStore(getPageKey(location.href));
    const layout = new LayoutTracker(ctx);

    const ui = await createShadowRootUi<Mounted>(ctx, {
      name: WEBMARK_HOST_TAG,
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
        return { root: createRoot(appRoot), pickerLayer };
      },
      onRemove(mounted) {
        mounted?.root.unmount();
      },
    });
    if (ctx.isInvalid) return;

    ui.mount();
    const mounted = ui.mounted;
    if (!mounted) return;
    keepHostAttached(ctx, ui.shadowHost);

    const controller = new Controller({
      ctx,
      store,
      layout,
      host: ui.shadowHost,
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
