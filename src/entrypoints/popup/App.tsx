import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { Button } from '@/components/Button';
import { useCommandShortcut, useSettings, useToast } from '@/components/hooks';
import { IconLayoutGrid, IconPanelRight, IconPlus } from '@/components/icons';
import { Kbd } from '@/components/Kbd';
import { Logo } from '@/components/Logo';
import { MissingScriptNotice, RestrictedPageNotice } from '@/components/PageNotice';
import { canOpenSidePanel } from '@/components/platform';
import { Switch } from '@/components/Switch';
import { Toaster } from '@/components/Toaster';
import { useCurrentPage, type CurrentPage } from '@/components/useCurrentPage';
import { openDashboard, openSidePanel } from '@/lib/compat';
import { DEFAULT_SHORTCUTS } from '@/lib/constants';
import { sendToTab } from '@/lib/messages';
import { PageNoteList } from './PageNoteList';
import { PageStats } from './PageStats';

const UNREACHABLE = "Couldn't reach the page. Try reloading it.";

export function App() {
  const page = useCurrentPage();
  const toast = useToast();
  const [windowId, setWindowId] = useState<number>();
  const sidePanelSupported = canOpenSidePanel();

  // Fetched up front: the side panel must open synchronously inside the click handler.
  useEffect(() => {
    browser.windows.getCurrent().then(
      (win) => setWindowId(win.id),
      () => undefined,
    );
  }, []);

  const openPanel = () => {
    openSidePanel(windowId).then(
      () => window.close(),
      () => toast("Couldn't open the side panel", { tone: 'danger' }),
    );
  };

  const openAllNotes = () => {
    openDashboard().then(
      () => window.close(),
      () => toast("Couldn't open the dashboard", { tone: 'danger' }),
    );
  };

  const allNotesButton = (
    <Button variant="secondary" icon={<IconLayoutGrid size={14} />} onClick={openAllNotes}>
      All notes
    </Button>
  );

  let content;
  if (page.status === 'restricted') {
    content = <RestrictedPageNotice compact>{allNotesButton}</RestrictedPageNotice>;
  } else if (page.status === 'missing') {
    content = <MissingScriptNotice compact tabId={page.tabId} url={page.url} />;
  } else if (page.status === 'loading') {
    content = (
      <div className="popup-loading" role="status">
        <div className="wm-spinner" />
        <span>{page.tab?.status === 'loading' ? 'Waiting for the page to load…' : 'Connecting to the page…'}</span>
      </div>
    );
  } else {
    content = <ReadyView page={page} unreachable={() => toast(UNREACHABLE, { tone: 'danger' })} />;
  }

  return (
    <div className="popup">
      <header className="popup__header">
        <Logo size={22} />
        <span className="wm-wordmark">WebMark</span>
        {page.site ? (
          <span className="popup__site" title={page.url}>
            {page.site}
          </span>
        ) : null}
      </header>

      <main className="popup__main">{content}</main>

      <footer className="popup__footer">
        {sidePanelSupported ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<IconPanelRight size={14} />}
            onClick={openPanel}
            disabled={!import.meta.env.FIREFOX && windowId === undefined}
          >
            Side panel
          </Button>
        ) : null}
        {/* The restricted notice already has its own "All notes" button. */}
        {page.status !== 'restricted' ? (
          <Button variant="ghost" size="sm" icon={<IconLayoutGrid size={14} />} onClick={openAllNotes}>
            All notes
          </Button>
        ) : null}
      </footer>
      <Toaster />
    </div>
  );
}

interface ReadyViewProps {
  page: CurrentPage;
  unreachable: () => void;
}

function ReadyView({ page, unreachable }: ReadyViewProps) {
  const [settings, updateSettings, settingsReady] = useSettings();
  const pickerShortcut = useCommandShortcut('start-picker', DEFAULT_SHORTCUTS.startPicker);
  const pinsShortcut = useCommandShortcut('toggle-pins', DEFAULT_SHORTCUTS.togglePins);
  const [busy, setBusy] = useState(false);

  const startPicker = async () => {
    if (page.tabId === undefined || busy) return;
    setBusy(true);
    const res = await sendToTab(page.tabId, { type: 'wm:start-picker' });
    setBusy(false);
    if (!res) {
      unreachable();
      page.refreshPageState();
      return;
    }
    window.close();
  };

  const focusNote = async (noteId: string) => {
    if (page.tabId === undefined) return;
    const res = await sendToTab(page.tabId, { type: 'wm:focus-note', noteId });
    if (!res) {
      unreachable();
      return;
    }
    window.close();
  };

  return (
    <>
      <section className="popup-actions">
        <Button
          variant="primary"
          block
          icon={<IconPlus size={15} />}
          trailing={pickerShortcut ? <Kbd shortcut={pickerShortcut} decorative /> : null}
          aria-keyshortcuts={pickerShortcut.includes('+') ? pickerShortcut.replace(/\s/g, '') : undefined}
          onClick={() => void startPicker()}
          disabled={busy}
          className="popup-actions__add"
        >
          Add note
        </Button>
        <div className="popup-actions__row" title={pinsShortcut ? `Shortcut: ${pinsShortcut}` : undefined}>
          <Switch
            checked={settings.pinsVisible}
            onChange={(visible) => void updateSettings({ pinsVisible: visible })}
            label="Show pins on page"
            labelFirst
            disabled={!settingsReady}
            className="popup-actions__switch"
          />
        </div>
      </section>

      {page.notes.length ? <PageStats notes={page.notes} orphanedIds={page.orphanedIds} /> : null}

      <PageNoteList notes={page.notes} orphanedIds={page.orphanedIds} onSelect={(id) => void focusNote(id)} />
    </>
  );
}
