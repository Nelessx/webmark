import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { resolveAnchor } from '@/lib/anchor';
import { isWebmarkNode } from '@/lib/constants';
import type { Note } from '@/lib/types';
import type { AppStore } from './store';

/*
 * Keeps `state.resolved` (noteId → element) in sync with the page.
 *
 * The MutationObserver is bounded by what could change the answer:
 *   - no notes            → not observing at all
 *   - every note resolved → childList only, just to notice elements leaving the DOM
 *   - some notes orphaned → childList + attributes, since a class/id/attribute
 *                           change can make an element match
 * Callbacks only set a debounced timer; the real work happens once the page
 * settles (with a max wait so constantly-mutating pages still get checked).
 * Fuzzy resolution of orphans can be expensive, so orphan-only retries back
 * off exponentially while they keep failing; an element leaving the DOM is
 * still handled promptly.
 * The observer watches <html> rather than <body> because some sites (Turbo,
 * pjax) swap the whole <body> element on navigation.
 */

const MIN_DELAY_MS = 350;
const MAX_DELAY_MS = 2000;
const MAX_WAIT_MS = 2500;
const ORPHAN_RETRY_BASE_MS = 1000;
const ORPHAN_MAX_BACKOFF = 8;

type ObserveMode = 'off' | 'childList' | 'full';

function findElement(note: Note): Element | null {
  try {
    const el = resolveAnchor(note.anchor)?.element;
    return el && el.isConnected && !isWebmarkNode(el) ? el : null;
  } catch {
    return null;
  }
}

function anchorSignature(note: Note): string {
  return JSON.stringify(note.anchor);
}

function sameMap(a: ReadonlyMap<string, Element>, b: ReadonlyMap<string, Element>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

export class NoteResolver {
  private readonly observer: MutationObserver;
  private mode: ObserveMode = 'off';
  /** Anchor each resolved element was found with, to re-resolve when a note's anchor is edited. */
  private readonly signatures = new Map<string, string>();
  private timer = 0;
  private pendingSince = 0;
  private delay = MIN_DELAY_MS;
  private orphanBackoff = 1;
  private orphanRetryAt = 0;

  constructor(
    private readonly ctx: ContentScriptContext,
    private readonly store: AppStore,
    private readonly host: Element,
    /** Called after each debounced DOM check, e.g. to re-measure positions. */
    private readonly onDomSettled: () => void,
  ) {
    this.observer = new MutationObserver((records) => this.onMutations(records));
    ctx.onInvalidated(() => this.dispose());
  }

  /**
   * Bring `resolved` up to date with the current notes: keep matches that are
   * still in the document (and whose anchor is unchanged), resolve the rest.
   */
  sync(): void {
    const { notes, resolved } = this.store.get();
    const next = new Map<string, Element>();
    const started = performance.now();
    for (const note of notes) {
      const current = resolved.get(note.id);
      const signature = anchorSignature(note);
      if (current?.isConnected && this.signatures.get(note.id) === signature) {
        next.set(note.id, current);
        continue;
      }
      const el = findElement(note);
      if (el) {
        next.set(note.id, el);
        this.signatures.set(note.id, signature);
      }
    }
    for (const id of this.signatures.keys()) if (!next.has(id)) this.signatures.delete(id);
    // Back off on pages where resolving is expensive.
    this.delay = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, (performance.now() - started) * 10));

    this.store.set((s) => ({ resolved: sameMap(next, s.resolved) ? s.resolved : next, resolvedOnce: true }));
    this.updateObserver();
  }

  /** Record an element we already know (a note just created from it) without resolving. */
  adopt(note: Note, element: Element): void {
    this.signatures.set(note.id, anchorSignature(note));
    this.store.set((s) => {
      const resolved = new Map(s.resolved);
      resolved.set(note.id, element);
      return { resolved };
    });
    this.updateObserver();
  }

  /** Current element for a note, trying a fresh resolve if it isn't resolved. */
  elementFor(noteId: string): Element | null {
    const state = this.store.get();
    const current = state.resolved.get(noteId);
    if (current?.isConnected) return current;
    const note = state.notes.find((n) => n.id === noteId);
    if (!note) return null;
    this.sync();
    return this.store.get().resolved.get(noteId) ?? null;
  }

  /** Forget everything (page changed). Resolution restarts with the next sync(). */
  reset(): void {
    this.cancelTimer();
    this.signatures.clear();
    this.orphanBackoff = 1;
    this.orphanRetryAt = 0;
    this.setMode('off');
  }

  /** Run a DOM check after `ms` instead of right away (used after SPA navigation). */
  syncSoon(ms: number): void {
    this.cancelTimer();
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.sync();
      this.onDomSettled();
    }, ms);
  }

  private updateObserver(): void {
    const { notes, resolved } = this.store.get();
    if (!notes.length) this.setMode('off');
    else this.setMode(notes.every((n) => resolved.has(n.id)) ? 'childList' : 'full');
  }

  private setMode(mode: ObserveMode): void {
    if (mode === this.mode) return;
    this.observer.disconnect();
    this.mode = mode;
    if (mode === 'off') return;
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: mode === 'full',
    });
  }

  private onMutations(records: MutationRecord[]): void {
    if (this.ctx.isInvalid) return;
    if (records.some((r) => this.isRelevant(r))) this.scheduleCheck();
  }

  private isRelevant(record: MutationRecord): boolean {
    const target = record.target;
    if (target === this.host) return false;
    const head = document.head;
    if (head && (target === head || head.contains(target))) return false;
    if (record.type === 'childList') {
      // Our own host being (re)attached is not a page change.
      const nodes = [...record.addedNodes, ...record.removedNodes];
      if (nodes.length && nodes.every((n) => n === this.host)) return false;
    }
    return true;
  }

  private scheduleCheck(): void {
    const now = performance.now();
    if (!this.pendingSince) this.pendingSince = now;
    this.checkIn(Math.min(this.delay, this.pendingSince + MAX_WAIT_MS - now));
  }

  private checkIn(ms: number): void {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.pendingSince = 0;
      this.check();
    }, Math.max(0, ms));
  }

  private orphanCount(): number {
    const { notes, resolved } = this.store.get();
    return notes.filter((n) => !resolved.has(n.id)).length;
  }

  private check(): void {
    if (this.ctx.isInvalid) return;
    const { notes, resolved } = this.store.get();
    if (!notes.length) return;
    const orphans = this.orphanCount();
    const lostElement = [...resolved.values()].some((el) => !el.isConnected);
    const now = performance.now();

    if (lostElement || (orphans && now >= this.orphanRetryAt)) {
      this.sync();
      const remaining = this.orphanCount();
      this.orphanBackoff = remaining && remaining >= orphans ? Math.min(this.orphanBackoff * 2, ORPHAN_MAX_BACKOFF) : 1;
      this.orphanRetryAt = remaining ? now + ORPHAN_RETRY_BASE_MS * this.orphanBackoff : 0;
    } else if (orphans) {
      // Not due yet: make sure the retry still happens if the page goes quiet.
      this.checkIn(this.orphanRetryAt - now);
    }
    this.onDomSettled();
  }

  private cancelTimer(): void {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = 0;
    this.pendingSince = 0;
  }

  private dispose(): void {
    this.cancelTimer();
    this.observer.disconnect();
    this.mode = 'off';
  }
}
