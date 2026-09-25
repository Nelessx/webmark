import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser }) => ({
    name: 'WebMark',
    description:
      'Attach notes to any element on any webpage. Client feedback, QA and design review — right on the page.',
    permissions: [
      'storage',
      'unlimitedStorage',
      'tabs',
      'activeTab',
      'scripting',
      browser === 'firefox' ? 'menus' : 'contextMenus',
    ],
    // Local-first build: WebMark runs on every site. Narrow this before publishing.
    host_permissions: ['<all_urls>'],
    // --- Isolated note editor (src/lib/editor/protocol.ts) ---
    // Framed into pages by the content script. Chrome serves it only under a
    // per-session URL, so pages can't probe for WebMark by loading it; WXT
    // turns this into MV2's plain list for Firefox (moz-extension:// UUIDs are
    // per install already).
    web_accessible_resources: [
      {
        resources: ['note-editor.html'],
        matches: ['<all_urls>'],
        ...(browser === 'firefox' ? {} : { use_dynamic_url: true }),
      },
    ],
    action: {
      default_title: 'WebMark',
    },
    commands: {
      'start-picker': {
        suggested_key: { default: 'Alt+Shift+M' },
        description: 'Select an element on the page and add a note',
      },
      'toggle-pins': {
        suggested_key: { default: 'Alt+Shift+P' },
        description: 'Show or hide WebMark pins on the page',
      },
    },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'webmark@webmark.local',
              strict_min_version: '115.0',
              // Notes never leave the browser, so no data is collected.
              data_collection_permissions: { required: ['none'] },
            },
          },
        }
      : {}),
  }),
});
