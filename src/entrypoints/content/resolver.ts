import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { ACCEPT_SCORE, ANCHOR_ATTRIBUTES, contentFingerprint, resolveAnchor, watchRootFor } from '@/lib/anchor';
import { isWebmarkNode } from '@/lib/constants';
import type { Note } from '@/lib/types';
import type { AppStore } from './store';

/*
 * Keeps `state.resolved` (noteId → element) in sync with the page.
 *
 * Two MutationObservers, bounded by what could change the answer:
 *   - structure, on <html>: off with no notes; childList while every note is
 *     resolved (to notice elements leaving the DOM); plus the attributes
 *     anchors read while some are orphaned (a class/id change can make one
 *     match). <html> rather than <body> because some sites (Turbo, pjax) swap
 *     the whole <body> on navigation.
 *   - content, on each resolved element's watch root (its card or row, see
 *     watchRootFor): text and attribute changes. Frameworks recycle nodes
 *     (index-keyed lists, pagination, virtual scrolling) and rewrite their
 *     text in place, so a kept element whose content changed is re-resolved
 *     and kept only if it is still the best confident match. Live content
 *     (clocks, counters, KPIs) is re-verified at a growing interval, so it
 *     never causes constant re-resolution.
 * Callbacks only mark what changed and set a debounced timer; the real work
 * happens once the page settles (with a max wait so constantly-mutating pages
 * still get checked). A check re-resolves only notes whose element was lost
 * or changed; orphans are retried on their own exponential backoff. Work is
 * time-sliced so many notes never block the page for long.
 */

const MIN_DELAY_MS = 350;
const MAX_DELAY_MS = 2000;
const MAX_WAIT_MS = 2500;
const ORPHAN_RETRY_BASE_MS = 1000;
const ORPHAN_MAX_BACKOFF = 8;
const VERIFY_BASE_MS = 1000;
const VERIFY_MAX_BACKOFF = 8;
/** Resolve work done before yielding to the page. */
const SLICE_MS = 8;
const TIMER_SLACK_MS = 5;
const OBSERVED_ATTRIBUTES = [...ANCHOR_ATTRIBUTES];

type ObserveMode = 'off' | 'childList' | 'full';

interface Kept {
  element: Element;
  /** Subtree whose content identifies the element (see watchRootFor). */
  root: Element;
  fingerprint: string;
  /** The anchor it was resolved from: an edited anchor re-resolves. */
  signature: string;
  /** Something inside `root` mutated since the fingerprint was last compared. */
  dirty: boolean;
  /** A content change seen before this time waits, so live content doesn't re-resolve constantly. */
  verifyAfter: number;
  backoff: number;
}

interface Orphan {
  retryAt: number;
  backoff: number;
}

interface Pass {
  queue: Note[];
  /** Verify changed elements and retry orphans now, whatever their backoff. */
  force: boolean;
  /** Started by a timer rather than by page changes: must not schedule orphan retries itself. */
  followUp: boolean;
  spent: number;
  done: (() => void)[];
}

const signatures = new WeakMap<Note, string>();

function anchorSignature(note: Note): string {
  let signature = signatures.get(note);
  if (signature === undefined) {
    signature = JSON.stringify(note.anchor);
    signatures.set(note, signature);
  }
  return signature;
}

function findElement(note: Note): Element | null {
  try {
    const result = resolveAnchor(note.anchor);
    // A pin on a doubtful match is worse than an orphaned note.
    if (!result || result.confidence < ACCEPT_SCORE) return null;
    const el = result.element;
    return el.isConnected && !isWebmarkNode(el) ? el : null;
  } catch {
    return null;
  }
}

function isAttached(kept: Kept): boolean {
  return kept.element.isConnected && (kept.root === kept.element || kept.root.contains(kept.element));
}

function sameMap(a: ReadonlyMap<string, Element>, b: ReadonlyMap<string, Element>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

export class NoteResolver {
  private readonly structure: MutationObserver;
  private readonly content: MutationObserver;
  private mode: ObserveMode = 'off';
  private watched = new Set<Element>();
  private readonly kept = new Map<string, Kept>();
  private readonly orphans = new Map<string, Orphan>();
  private pass: Pass | null = null;
  private timer = 0;
  private pendingSince = 0;
  private delay = MIN_DELAY_MS;
  /** Continuation of a time-sliced pass. */
  private slice = 0;
  /** Earliest time a throttled verification / a skipped orphan retry of the current pass is due. */
  private verifyDue = Infinity;
  private retryDue = Infinity;

  constructor(
    private readonly ctx: ContentScriptContext,
    private readonly store: AppStore,
    private readonly host: Element,
    /** Called after each debounced DOM check, e.g. to re-measure positions. */
    private readonly onDomSettled: () => void,
  ) {
    const onMutations = (records: MutationRecord[]) => this.onMutations(records);
    this.structure = new MutationObserver(onMutations);
    this.content = new MutationObserver(onMutations);
    ctx.onInvalidated(() => this.stop());
  }

  /**
   * Bring `resolved` up to date with the current notes: keep elements that
   * are still in the document and unchanged, re-verify changed ones, resolve
   * the rest.
   */
  sync(): void {
    this.runPass(true, false, () => this.store.set({ resolvedOnce: true }));
  }

  /** Record an element we already know (a note just created from it) without resolving. */
  adopt(note: Note, element: Element): void {
    this.settle(note, element, performance.now());
    this.commit();
  }

  /** Current element for a note, verified against its anchor; tries a fresh resolve if it isn't resolved. */
  elementFor(noteId: string): Element | null {
    const note = this.store.get().notes.find((n) => n.id === noteId);
    if (!note) return null;
    this.step(note, true);
    this.commit();
    return this.kept.get(noteId)?.element ?? null;
  }

  /** Forget everything (page changed). Resolution restarts with the next sync(). */
  reset(): void {
    this.stop();
    this.kept.clear();
    this.orphans.clear();
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

  /**
   * Bring every note up to date, a slice at a time. A pass requested while
   * another is unfinished restarts it, keeping the stronger options and all
   * completion callbacks.
   */
  private runPass(force: boolean, followUp: boolean, done: () => void): void {
    const previous = this.pass;
    this.cancelSlice();
    this.verifyDue = Infinity;
    this.retryDue = Infinity;
    this.pass = {
      queue: [...this.store.get().notes],
      force: force || !!previous?.force,
      followUp: followUp && (previous?.followUp ?? true),
      spent: 0,
      done: [...(previous?.done ?? []), done],
    };
    this.runSlice();
  }

  private runSlice(): void {
    this.slice = 0;
    const pass = this.pass;
    if (!pass || this.ctx.isInvalid) return;
    const started = performance.now();
    do {
      const note = pass.queue.shift();
      if (note) this.step(note, pass.force);
    } while (pass.queue.length && performance.now() - started < SLICE_MS);
    pass.spent += performance.now() - started;
    this.commit();
    if (pass.queue.length) {
      this.slice = window.setTimeout(() => this.runSlice(), 0);
      return;
    }
    this.pass = null;
    // Back off on pages where resolving is expensive.
    this.delay = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, pass.spent * 10));
    // Make sure skipped work still happens if the page goes quiet (a check
    // already pending re-evaluates it anyway). Orphan retries only get this
    // from page changes, so a quiet page isn't polled.
    const due = Math.min(this.verifyDue, pass.followUp ? Infinity : this.retryDue);
    if (due < Infinity && !this.timer) this.checkIn(due - performance.now(), true);
    for (const callback of pass.done) callback();
  }

  /** Bring one note up to date. */
  private step(note: Note, force: boolean): void {
    const now = performance.now();
    // Timers fire up to a millisecond early against performance.now(): a
    // follow-up check must not find what it was scheduled for still not due.
    const notDue = (time: number) => !force && now + TIMER_SLACK_MS < time;
    const kept = this.kept.get(note.id);
    if (kept && kept.signature === anchorSignature(note) && isAttached(kept)) {
      if (!force && !kept.dirty) return;
      const fingerprint = contentFingerprint(kept.element, kept.root);
      if (fingerprint === kept.fingerprint) {
        kept.dirty = false;
        return;
      }
      if (notDue(kept.verifyAfter)) {
        this.verifyDue = Math.min(this.verifyDue, kept.verifyAfter);
        return;
      }
      const found = findElement(note);
      if (found !== kept.element) {
        this.settle(note, found, now);
        return;
      }
      // Same element, new content (a live value): keep it, and re-check less often while it keeps changing.
      kept.fingerprint = fingerprint;
      kept.dirty = false;
      kept.backoff = Math.min(kept.backoff * 2, VERIFY_MAX_BACKOFF);
      kept.verifyAfter = now + VERIFY_BASE_MS * kept.backoff;
      return;
    }
    const orphan = kept ? undefined : this.orphans.get(note.id);
    if (orphan && notDue(orphan.retryAt)) {
      this.retryDue = Math.min(this.retryDue, orphan.retryAt);
      return;
    }
    this.settle(note, findElement(note), now);
  }

  private settle(note: Note, element: Element | null, now: number): void {
    if (element) {
      const root = watchRootFor(note.anchor, element);
      this.kept.set(note.id, {
        element,
        root,
        fingerprint: contentFingerprint(element, root),
        signature: anchorSignature(note),
        dirty: false,
        verifyAfter: 0,
        backoff: 1,
      });
      this.orphans.delete(note.id);
      return;
    }
    const justLost = this.kept.delete(note.id);
    const previous = justLost ? undefined : this.orphans.get(note.id);
    // A note that just lost (or never had) its element is retried on the next
    // page change, e.g. lazy content; one that keeps failing backs off.
    const backoff = previous ? Math.min(Math.max(previous.backoff * 2, 1), ORPHAN_MAX_BACKOFF) : 0;
    this.orphans.set(note.id, { retryAt: now + ORPHAN_RETRY_BASE_MS * backoff, backoff });
  }

  /** Publish the kept elements of the current notes, and observe accordingly. */
  private commit(): void {
    const { notes } = this.store.get();
    const ids = new Set(notes.map((n) => n.id));
    for (const id of this.kept.keys()) if (!ids.has(id)) this.kept.delete(id);
    for (const id of this.orphans.keys()) if (!ids.has(id)) this.orphans.delete(id);
    const next = new Map<string, Element>();
    for (const note of notes) {
      const kept = this.kept.get(note.id);
      if (kept) next.set(note.id, kept.element);
    }
    this.store.set((s) => ({ resolved: sameMap(next, s.resolved) ? s.resolved : next }));
    this.updateObservers();
  }

  private updateObservers(): void {
    const { notes } = this.store.get();
    if (!notes.length) this.setMode('off');
    else this.setMode(notes.every((n) => this.kept.has(n.id)) ? 'childList' : 'full');
    this.watch(new Set([...this.kept.values()].map((kept) => kept.root)));
  }

  private setMode(mode: ObserveMode): void {
    if (mode === this.mode) return;
    this.deliverPending(this.structure);
    this.structure.disconnect();
    this.mode = mode;
    if (mode === 'off') return;
    this.structure.observe(document.documentElement, {
      childList: true,
      subtree: true,
      ...(mode === 'full' ? { attributes: true, attributeFilter: OBSERVED_ATTRIBUTES } : {}),
    });
  }

  /** Observe text and anchor-relevant attribute changes inside the watch roots. */
  private watch(roots: Set<Element>): void {
    if (roots.size === this.watched.size && [...roots].every((root) => this.watched.has(root))) return;
    this.deliverPending(this.content);
    this.content.disconnect();
    this.watched = roots;
    for (const root of roots) {
      this.content.observe(root, {
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: OBSERVED_ATTRIBUTES,
      });
    }
  }

  /** Disconnecting drops queued records: handle them first. */
  private deliverPending(observer: MutationObserver): void {
    const pending = observer.takeRecords();
    if (pending.length) this.onMutations(pending);
  }

  private onMutations(records: MutationRecord[]): void {
    if (this.ctx.isInvalid) return;
    const touched = new Set<Element>();
    let relevant = false;
    for (const record of records) {
      if (!this.isRelevant(record)) continue;
      relevant = true;
      this.collectWatchRoots(record.target, touched);
    }
    if (touched.size) {
      for (const kept of this.kept.values()) if (touched.has(kept.root)) kept.dirty = true;
    }
    if (relevant) this.scheduleCheck();
  }

  /** Watch roots containing `node` (roots can nest: a note on a card and one on a button in it). */
  private collectWatchRoots(node: Node, into: Set<Element>): void {
    if (!this.watched.size) return;
    for (let current: Node | null = node; current; current = current.parentNode) {
      if (this.watched.has(current as Element)) into.add(current as Element);
    }
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

  private checkIn(ms: number, followUp = false): void {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.pendingSince = 0;
      this.check(followUp);
    }, Math.max(0, ms));
  }

  private check(followUp: boolean): void {
    if (this.ctx.isInvalid || !this.store.get().notes.length) return;
    this.runPass(false, followUp, () => this.onDomSettled());
  }

  private cancelTimer(): void {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = 0;
    this.pendingSince = 0;
  }

  private cancelSlice(): void {
    if (this.slice) window.clearTimeout(this.slice);
    this.slice = 0;
  }

  /** Stop all work and observation, dropping anything queued. */
  private stop(): void {
    this.cancelTimer();
    this.cancelSlice();
    this.pass = null;
    this.structure.disconnect();
    this.content.disconnect();
    this.mode = 'off';
    this.watched = new Set();
  }
}
