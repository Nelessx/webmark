import { useMemo } from 'react';
import type { Browser } from 'wxt/browser';
import type { PageState } from '@/lib/messages';
import type { Note } from '@/lib/types';
import { canRunOn, getPageKey, siteOf } from '@/lib/url';
import { useActiveTab, usePageNotes, usePageState } from './hooks';

/**
 * - loading:    tab, page or content script not known yet
 * - restricted: browser/store page where extensions can't run
 * - missing:    runnable page without WebMark's content script (needs a reload)
 * - ready:      content script answered
 */
export type PageStatus = 'loading' | 'restricted' | 'missing' | 'ready';

export interface CurrentPage {
  tab: Browser.tabs.Tab | undefined;
  tabId: number | undefined;
  windowId: number | undefined;
  url: string | undefined;
  /** getPageKey(tab.url) when WebMark can run on the page. */
  pageKey: string | undefined;
  title: string;
  site: string;
  status: PageStatus;
  /** This page's notes, oldest first (pin order). Live. */
  notes: Note[];
  notesLoading: boolean;
  /** Content script state, only when it describes this page. */
  pageState: PageState | undefined;
  /** Ids of notes whose element is not on the page. */
  orphanedIds: ReadonlySet<string>;
  refreshPageState: () => void;
}

const NO_IDS: ReadonlySet<string> = new Set();

/** Everything the popup and side panel need about the active tab's page. */
export function useCurrentPage(): CurrentPage {
  const tab = useActiveTab();
  const url = tab?.url || undefined;
  const runnable = canRunOn(url);
  const pageKey = runnable && url ? getPageKey(url) : undefined;
  const { notes, loading: notesLoading } = usePageNotes(pageKey);
  const page = usePageState(runnable ? tab?.id : undefined);

  const pageState = page.state && page.state.pageKey === pageKey ? page.state : undefined;
  const orphanedIds = useMemo(
    () => (pageState?.orphanedIds.length ? new Set(pageState.orphanedIds) : NO_IDS),
    [pageState],
  );

  let status: PageStatus;
  if (!tab || (!url && tab.status === 'loading')) status = 'loading';
  else if (!runnable) status = 'restricted';
  else if (page.missing) status = 'missing';
  // A settled answer counts even if its pageKey lags behind a client-side navigation.
  else if (pageState || (page.state && !page.loading)) status = 'ready';
  else status = 'loading';

  return {
    tab,
    tabId: tab?.id,
    windowId: tab?.windowId,
    url,
    pageKey,
    title: tab?.title || pageState?.title || '',
    site: url ? siteOf(url) : '',
    status,
    notes,
    notesLoading,
    pageState,
    orphanedIds,
    refreshPageState: page.refresh,
  };
}
