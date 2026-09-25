# WebMark

<img src="public/icon/128.png" alt="" width="64" height="64" align="right">

WebMark is a browser extension for Chrome, Edge, Brave and Firefox that lets you select any element on any webpage (a card, a button, a paragraph, anything), attach a note to it, and find it again later. Instead of "the number on the dashboard is wrong" in a chat thread, the feedback reads **[Dashboard → Revenue Card] Change this to monthly revenue** and is pinned to that card on the page. The core idea: **connect feedback to the exact element it refers to.**

It is built for developers collecting client feedback, QA testers, designers and content reviewers. For now WebMark is **local-only**: no server and no accounts. Notes are stored in your browser profile, and you share them by exporting.

## Features

- **Element picker:** hover to highlight, move to the parent or child element with the arrow keys, click or press Enter to select.
- **Note editor:** a popover next to the element. Notes are plain text and carry tags, a status (Open, In progress, Completed, Archived) and a priority (Low, Medium, High). Archived notes are put away: no pin on the page, and listed only under the Archived filter.
- **Numbered pins** on annotated elements, coloured by status, with a red dot for high priority. `#3` refers to the same note on the page, in the popup, in the side panel and in reports.
- **Reliable anchoring:** each note stores several ways to find its element again (selector, XPath, attributes, text, position), so it survives most redesigns. Notes whose element cannot be found are listed as *orphaned* rather than lost.
- **Single-page app support:** pins update when the URL changes without a full page load.
- **Screenshots (optional):** a cropped screenshot of the element is saved with each new note.
- **Popup:** quick actions and the notes on the current page.
- **Side panel:** the current page's notes with search, status, priority and tag filters, and editing.
- **Dashboard:** every note on every site, with search, filters, sorting, bulk actions (status, priority, report, delete), export, import, settings and a welcome guide.
- **Export and import:** JSON (full backup, optionally with screenshots), a Markdown report and CSV. Reports and CSV hold the notes the list shows; a backup holds every note.
- **Toolbar badge** showing how many notes on the current page still need work (open or in progress).

## Install and run

Requirements: Node.js 20 or later, and npm.

```sh
npm install          # also runs `wxt prepare` to generate types
```

### Development (hot reload)

```sh
npm run dev          # launches Chrome with WebMark loaded
npm run dev:firefox  # launches Firefox with WebMark loaded
```

### Load a production build by hand

```sh
npm run build          # -> .output/chrome-mv3
npm run build:firefox  # -> .output/firefox-mv2
```

- **Chrome / Edge / Brave:** open `chrome://extensions` (or `edge://extensions`, `brave://extensions`), turn on **Developer mode**, click **Load unpacked** and choose `.output/chrome-mv3`.
- **Firefox:** open `about:debugging`, choose **This Firefox**, click **Load Temporary Add-on…** and pick `.output/firefox-mv2/manifest.json`. Temporary add-ons are removed when Firefox restarts.

`npm run zip` and `npm run zip:firefox` produce store-ready archives in `.output/`.

## Usage

| Action | How |
|---|---|
| Start the picker | Press **Alt+Shift+M**, or use the popup's quick actions |
| Note on a specific element | Right-click it and choose **Add WebMark note to this element** |
| Move the selection in the picker | **↑** parent element, **↓** child element |
| Select / cancel | **Enter** or click to select, **Esc** to cancel |
| Show / hide pins | **Alt+Shift+P**, or the toggle in the popup (applies to every tab) |
| Read or edit a note | Click its pin, or open it from the popup, side panel or dashboard |
| Review all notes | Open the dashboard from the popup |
| Share feedback | Export from the dashboard as JSON, Markdown or CSV. The recipient imports the JSON file into their own WebMark |

Keyboard shortcuts can be changed at `chrome://extensions/shortcuts` (Chromium) or under **Manage Extension Shortcuts** in `about:addons` (Firefox).

## Architecture

Built with [WXT](https://wxt.dev) (source in `src/`), React 19 and TypeScript. All in-page UI is rendered inside a Shadow DOM (`<webmark-ui>`) so page styles cannot break it and it cannot break the page.

### Entry points (`src/entrypoints/`)

| Entry point | Role |
|---|---|
| `content/index.tsx` | Runs on every page: element picker, note editor popover, numbered pins, orphaned-note handling, single-page app navigation. The only handler of `ContentMessage`s. |
| `note-editor/` | The note form, an extension page the content script frames inside its closed shadow root (`/note-editor.html`), so the page never sees what is typed. See `lib/editor/protocol.ts`. |
| `background.ts` | Context menu, keyboard shortcuts, screenshot capture and cropping, toolbar badge (count of open and in-progress notes), re-injection into already-open tabs on install. The only responder to `BackgroundMessage`s. |
| `popup/` | Toolbar popup: quick actions and the current page's notes. |
| `sidepanel/` | Side panel (Chromium) / sidebar (Firefox): the current page's notes with search, filters and editing. |
| `options/` | The dashboard, opened in a tab at `/options.html`: all notes, search, filters, bulk actions, export and import, settings, welcome guide. |

### Shared modules (`src/lib/`)

| Module | Role |
|---|---|
| `types.ts` | Data model: `Note`, `ElementAnchor`, `NotePatch`, `Settings`, `NOTE_SCHEMA_VERSION`. |
| `noteMeta.ts` | Note statuses and priorities: their order, labels and helpers, shared by every surface and export. |
| `badge.ts` | The toolbar badge text: the page's notes that still need work. |
| `url.ts` | `getPageKey()` normalises a URL into the key notes are stored under (drops tracking params, keeps hash routes like `#/…`); `canRunOn()` says whether a URL can host the content script. |
| `storage.ts` | All reads and writes of notes, screenshots and settings. Writes run in the background (the single writer), with a write queue, migrations and change listeners. |
| `messages.ts` | Typed message protocol between the content script, the background and extension pages. |
| `compat.ts` | Chromium/Firefox differences: action vs browserAction, contextMenus vs menus, side panel vs sidebar, opening the dashboard and revealing a note in a tab. |
| `constants.ts` | Shadow host tag, `isWebmarkNode()`, `pinNumber()`, default shortcuts. |
| `editor/` | The isolated note editor: session handshake between content script, background and editor frame (`protocol.ts`, `sessions.ts`), relayed events, unsaved-draft recovery, and saving (`save.ts`). |
| `anchor/` | `createAnchor()`, `resolveAnchor()`, `buildLabel()`, `describeElement()`: capturing and finding elements. |
| `format.ts` | Markdown note and report, CSV, relative times, tag parsing. |
| `export.ts` | JSON export bundle: build, parse and validate, import (merge or replace), download. |

Design tokens (`--wm-*`, light and dark) live in `src/assets/theme.css`. In-page CSS uses `px`, never `rem`, because `rem` follows the host site's root font size.

### Storage layout (`browser.storage.local`)

```
wm:pages               string[]      page keys that have at least one note
wm:notes:<pageKey>     Note[]        notes for one page, oldest first
wm:settings            Settings
wm:pending-focus       PendingFocus  note to focus after a page is opened from the dashboard
wm:storage-version     number        layout the background last migrated to
```

Notes are grouped per page so a content script reads only its own page. Screenshots (JPEG data URLs) live in IndexedDB in the extension's origin (`webmark` / `screenshots`, keyed by note id), so saving or deleting one isn't broadcast to every open tab; older versions kept them under `wm:shot:<noteId>`, which the background moves over on startup. The extension requests `unlimitedStorage`.

Every context reads storage directly, but all writes run in the background, one at a time: content scripts and extension pages send them as `wm:storage` messages (see `storage.ts`), so two contexts can never overwrite each other's changes. Credentials in page addresses (`?token=`, `#access_token=`, signed-URL signatures, session ids) are dropped from page keys and redacted from saved URLs and exports.

### Anchoring in brief

A single CSS selector breaks as soon as a page is redeployed with new class hashes or reordered lists, so `createAnchor()` records several independent signals: a unique selector built from stable attributes, an absolute XPath, the tag, a stable id and classes (auto-generated ones filtered out), identifying attributes (`data-testid`, `aria-label`, `role`, `name`, `href`, …), the element's text, its position and size in document coordinates, the viewport size, ancestor tags and its index among siblings of the same tag.

`resolveAnchor()` matches by selector or XPath when they still point at a plausible element, and otherwise falls back to a fuzzy search that scores candidates on all of those signals. It returns the element with a confidence between 0 and 1, and returns `null` when no candidate is convincing. The note is then shown as orphaned instead of being pinned to the wrong element.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `npm run dev:firefox` | Development build with hot reload in a fresh browser profile |
| `npm run build` / `npm run build:firefox` | Production build into `.output/` |
| `npm run zip` / `npm run zip:firefox` | Store-ready zip |
| `npm test` | Unit tests (Vitest + jsdom, `tests/unit/**`) |
| `npm run test:watch` | Unit tests in watch mode |
| `npm run compile` | Type-check (`tsc --noEmit`) |
| `npm run icons` | Regenerate `public/icon/*.png` (`scripts/generate-icons.mjs`, no dependencies) |
| `npm run test:e2e` | End-to-end tests (`tests/e2e/**`): builds with `wxt build --mode e2e` (the in-page UI uses an open shadow root only in that mode) into `.output/chrome-mv3-e2e`, then runs Playwright against it in headless Chromium. Needs `npx playwright install chromium` once; `HEADED=1` shows the browser |

## Known limitations

- **Pages the browser protects:** browser-internal pages (`chrome://`, `about:`, `edge://`, the new tab page, PDF viewers) and the extension stores (Chrome Web Store, Firefox Add-ons, Edge Add-ons) do not allow extensions to run.
- **Cross-origin iframes:** elements inside embedded frames from another origin cannot be annotated.
- **Unreachable content:** elements inside closed shadow roots, and apps that draw on a `<canvas>` (e.g. Figma, Google Docs, maps), have no DOM elements to anchor to.
- **Local only:** notes live in this browser profile. They do not sync across devices or to other people. Use export and import to move them.
- **Heavy page changes:** if an element's text, attributes and position all change, its note may become orphaned.
- **Pages that block extension frames:** where a page refuses WebMark's editor frame (e.g. `Cross-Origin-Embedder-Policy: require-corp`), notes are written in an in-page editor that says "Typing here is visible to this page."

## Roadmap

- **Sync and sharing:** accounts, shared projects, invite links and comment threads (needs a backend).
- **Per-site permissions before publishing:** the development build asks for access to all sites (`<all_urls>`). Before store release this moves to narrow or optional per-site permissions ("Enable WebMark on this site").
- **Integrations:** "copy as issue" text for GitHub, Jira and Trello.
- **Safari** support.

See [`docs/PLAN.md`](docs/PLAN.md) for the full product plan.
