import { useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { IconAlertTriangle, IconRotateCcw } from './icons';

export interface RestrictedPageNoticeProps {
  /** Extra actions, e.g. an "All notes" button. */
  children?: ReactNode;
  compact?: boolean;
}

/** Shown on browser pages and extension stores, where WebMark can't run. */
export function RestrictedPageNotice({ children, compact }: RestrictedPageNoticeProps) {
  return (
    <EmptyState
      compact={compact}
      tone="warning"
      icon={<IconAlertTriangle size={20} />}
      title="WebMark can't run on this page"
      description="Browsers don't let extensions add notes to their own pages or to extension stores. Open any website to start adding notes."
    >
      {children}
    </EmptyState>
  );
}

export interface MissingScriptNoticeProps {
  tabId: number | undefined;
  url: string | undefined;
  /** Called after the reload has been requested. */
  onReload?: () => void;
  children?: ReactNode;
  compact?: boolean;
}

/** The page was open before WebMark was installed or updated, so it needs a reload. */
export function MissingScriptNotice({ tabId, url, onReload, children, compact }: MissingScriptNoticeProps) {
  const [reloading, setReloading] = useState(false);
  const isFile = url?.startsWith('file:') ?? false;

  const reload = async () => {
    if (tabId === undefined) return;
    setReloading(true);
    try {
      await browser.tabs.reload(tabId);
      onReload?.();
    } finally {
      setReloading(false);
    }
  };

  return (
    <EmptyState
      compact={compact}
      icon={<IconRotateCcw size={20} />}
      title="Reload this page to start using WebMark"
      description={
        isFile
          ? 'For local files, also turn on "Allow access to file URLs" in WebMark\'s extension settings, then reload.'
          : 'This tab was opened before WebMark was installed or updated.'
      }
    >
      <Button variant="primary" icon={<IconRotateCcw size={14} />} onClick={() => void reload()} disabled={reloading || tabId === undefined}>
        Reload page
      </Button>
      {children}
    </EmptyState>
  );
}
