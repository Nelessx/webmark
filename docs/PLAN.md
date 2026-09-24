# WebMark: product plan

## Problem

Feedback on websites is hard to tie to the thing it is about.

- **"Which one?"** A client writes "the number on the dashboard is wrong". There are six numbers on the dashboard. Text feedback rarely says exactly which element it means.
- **Screenshots lack context.** A cropped screenshot shows *what* but not *where*: no URL, no page state, no link back to the live element, and it goes stale after the next deploy.
- **Feedback is scattered.** Comments arrive in chat, email, docs and calls. Nobody has one list of what is open and what is resolved for a given page.

## Users and use cases

| User | Use case |
|---|---|
| Developer or agency | Collect a client's feedback on a staging site, then work through it element by element and mark items resolved. |
| QA tester | Log a bug against the exact button or form field, with a screenshot, and export the list as issues. |
| Designer | Review a build against the design and leave notes on spacing, colours and copy right where they apply. |
| Content reviewer | Mark up headlines, paragraphs and images that need rewriting, then hand over a Markdown or CSV report. |
| Solo builder | Keep a to-do list attached to your own site while you build it. |

## Core idea

**Connect feedback to the exact element it refers to.** The user selects any element on any page, writes a note, and WebMark remembers the element robustly enough to find it again after reloads and most redesigns. Every note carries a readable label such as **[Dashboard → Revenue Card] Change this to monthly revenue**, so it makes sense even outside the page (in an export or an issue tracker).

## Phases

### Phase 0: Setup ✅
WXT project with React and TypeScript, manifest (Chrome MV3 and Firefox MV2), icons, shared contracts (types, storage, messages, compatibility helpers), design tokens, Vitest.

### Phase 1: MVP
- Element picker: hover highlight, ↑ / ↓ for parent / child, Enter or click to select, Esc to cancel.
- Note editor popover anchored to the element.
- Numbered pins on annotated elements, shown on revisit; global show/hide.
- Popup: quick actions and the current page's notes.
- Keyboard shortcuts (Alt+Shift+M, Alt+Shift+P) and a right-click "Add WebMark note to this element".

### Phase 2: Reliability
- Robust anchoring: several stored signals and a scored fuzzy match (see below).
- Single-page app support: re-resolve pins when the URL changes without a page load, and when the DOM changes.
- Orphaned notes: notes whose element cannot be found are listed, never silently dropped or pinned to the wrong element.
- Screenshots: a cropped image of the element saved with each note (optional in settings).
- Side panel: the current page's notes with search, filters and editing.
- Dashboard: every note across all sites, with search, filters and bulk actions.

### Phase 3: Export and import
- JSON export and import (merge or replace), optionally including screenshots. This is also the way to share notes while WebMark is local-only.
- Markdown report and CSV.
- "Copy as issue" text ready to paste into GitHub, Jira or Trello.

### Phase 4: Collaboration (future, needs a backend)
- Backend such as Supabase or Firebase.
- Accounts, shared projects, invite links.
- Comment threads on notes, assignment and status changes visible to the whole team.
- Integrations: create GitHub, Jira or Trello issues directly.
- Open question: whether clients can leave notes without installing the extension (e.g. a script tag or a shared review link).

### Phase 5: Publishing
- Chrome Web Store, Microsoft Edge Add-ons, Firefox Add-ons (AMO).
- Replace the development-time `<all_urls>` host permission with narrow or optional per-site permissions ("Enable WebMark on this site"), which store review looks on more favourably and users trust more.
- Privacy policy, store listing, screenshots, promotional images.

## Tech stack decisions

| Choice | Why |
|---|---|
| **WXT** | One codebase builds Chrome MV3 and Firefox MV2, with file-based entry points, typed manifest and hot reload. |
| **React 19** | Popup, side panel, dashboard and in-page editor share components; widely known by contributors. |
| **TypeScript** (strict, `noUncheckedIndexedAccess`) | The message protocol and stored data model are contracts between contexts; types catch mismatches at build time. |
| **Shadow DOM + plain CSS in px** | In-page UI is isolated from site styles in both directions; `px` because `rem` follows each site's root font size. |
| **`browser.storage.local` + `unlimitedStorage`** | Available in every extension context, survives restarts, no server needed; unlimited quota leaves room for screenshots. |
| **Vitest** (+ jsdom) | Fast unit tests for anchoring, URL keys, formatting and storage, using the same Vite setup as WXT. |
| **Playwright** | End-to-end tests that load the built extension into a real Chromium and click through the picker and pins. |

## Data model

Defined in `src/lib/types.ts`.

**Note**

| Field | Meaning |
|---|---|
| `id` | UUID |
| `schemaVersion` | Stored shape version (`NOTE_SCHEMA_VERSION`, currently 1); older notes are migrated on read |
| `pageKey` | Normalised page identity from `getPageKey()` (tracking params dropped, query sorted, hash kept only for `#/` routes) |
| `url`, `pageTitle` | Where and on which page the note was created |
| `label` | Readable breadcrumb for the element, e.g. "Dashboard → Revenue Card" |
| `body` | Plain-text note |
| `status` | `open` or `resolved` |
| `tags` | Free-form tags |
| `author` | From the author name in settings, empty if unset |
| `anchor` | `ElementAnchor`, see below |
| `hasScreenshot` | Whether a cropped screenshot is stored for this note |
| `createdAt`, `updatedAt` | Timestamps (ms) |

**ElementAnchor:** `selector`, `xpath`, `tagName`, optional stable `id`, stable `classes`, identifying `attributes`, whitespace-collapsed `text` (max 300 chars), `rect` in document coordinates, `viewport` size at capture, `ancestorTags` (nearest first, max 12), `nthOfType`.

**Settings:** `pinsVisible` (default on), `captureScreenshots` (default on), `authorName` (default empty).

**Storage keys** (`browser.storage.local`): `wm:pages` (page keys with notes), `wm:notes:<pageKey>` (that page's notes, oldest first), `wm:shot:<noteId>` (JPEG data URL), `wm:settings`, `wm:pending-focus` (note to reveal after opening a page from the dashboard). Pin numbers are the 1-based position of a note in its page's list, so `#3` means the same note everywhere.

## Anchoring strategy

1. **Capture several independent signals** when a note is created: a unique CSS selector built from stable attributes, an absolute XPath, tag, a stable id, stable classes (hashed and utility classes filtered out), identifying attributes (`data-testid`, `aria-label`, `role`, `name`, `href`, …), text content, position and size, viewport size, ancestor tags and sibling index.
2. **Resolve fast paths first:** if the selector or XPath still points at an element that agrees with the other signals, use it.
3. **Fall back to a scored search:** score candidate elements on tag, id, attributes, classes, text similarity, ancestor chain and distance from the original position (normalised by viewport size), and take the best one above a confidence threshold.
4. **Never guess badly:** below the threshold the note becomes *orphaned*. It stays in the lists with its label and screenshot so the user can re-attach or resolve it.
5. **Re-resolve on change:** for single-page apps, pins are re-resolved after URL changes and DOM mutations.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Pages change and notes attach to the wrong element | Multiple signals, a confidence threshold, orphaned state instead of a wrong match; unit tests with mutated fixtures. |
| Single-page apps change content without a page load | Watch URL changes and DOM mutations, re-resolve pins, key notes by normalised URL including hash routes. |
| WebMark UI clashes with site CSS or scripts | Shadow DOM, px-based design tokens, WebMark nodes excluded from picking and anchoring. |
| Performance on large pages | Resolve lazily and in batches, debounce mutation handling, keep screenshots out of note lists. |
| Storage growth from screenshots | JPEG crops of the element only, stored under separate keys; screenshots can be turned off. |
| Chromium and Firefox API differences | A small compatibility layer (`compat.ts`); test both targets. |
| Store review rejects broad host permissions | Move to optional per-site permissions before publishing (Phase 5). |
| Notes lost with the browser profile | JSON export/import now; cloud sync in Phase 4. |
| Clients must install an extension to leave feedback | Accept for now; explore link-based review in Phase 4. |
| Privacy: notes and screenshots may contain sensitive data | Everything stays local; no network requests; clear data from the dashboard. |
