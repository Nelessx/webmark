import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { sendToBackground, type PageState } from '@/lib/messages';
import { isActiveStatus, isArchivedStatus, isNoteStatus, NOTE_STATUSES } from '@/lib/noteMeta';
import type { NoteStatus } from '@/lib/types';
import type { AppState, AppStore } from './store';

const REPORT_DELAY_MS = 150;

export function computePageState(state: AppState): PageState {
  const resolvedIds: string[] = [];
  const orphanedIds: string[] = [];
  const statusCounts = Object.fromEntries(NOTE_STATUSES.map((status) => [status, 0])) as Record<NoteStatus, number>;
  let activeCount = 0;
  for (const note of state.notes) {
    if (isNoteStatus(note.status)) statusCounts[note.status]++;
    if (isActiveStatus(note.status)) activeCount++;
    if (state.resolved.has(note.id)) resolvedIds.push(note.id);
    // Before the first resolution pass a note is neither found nor missing
    // yet. Archived notes have no pin, so theirs is never missing.
    else if (state.resolvedOnce && !isArchivedStatus(note.status)) orphanedIds.push(note.id);
  }
  return {
    pageKey: state.pageKey,
    url: location.href,
    title: document.title,
    pinsVisible: state.settings.pinsVisible,
    pickerActive: state.pickerActive,
    resolvedIds,
    orphanedIds,
    activeCount,
    statusCounts,
  };
}

/**
 * Tell the background (toolbar badge, open side panels) when this tab's state
 * changes. Debounced, and only sent when the state actually differs from the
 * last report.
 */
export function reportPageStateChanges(ctx: ContentScriptContext, store: AppStore): void {
  let lastSent = '';
  let timer = 0;

  const flush = () => {
    timer = 0;
    if (ctx.isInvalid) return;
    const state = store.get();
    if (!state.notesLoaded) return;
    const pageState = computePageState(state);
    const serialized = JSON.stringify(pageState);
    if (serialized === lastSent) return;
    lastSent = serialized;
    void sendToBackground({ type: 'wm:page-state-changed', state: pageState });
  };

  const unsubscribe = store.subscribe(() => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(flush, REPORT_DELAY_MS);
  });

  ctx.onInvalidated(() => {
    unsubscribe();
    if (timer) window.clearTimeout(timer);
  });
}
