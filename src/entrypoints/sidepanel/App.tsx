import { Button } from '@/components/Button';
import { useCommandShortcut, useSettings, useToast } from '@/components/hooks';
import { IconCopy, IconLayoutGrid, IconPlus } from '@/components/icons';
import { Logo } from '@/components/Logo';
import { MissingScriptNotice, RestrictedPageNotice } from '@/components/PageNotice';
import { copyText } from '@/components/platform';
import { Switch } from '@/components/Switch';
import { Toaster } from '@/components/Toaster';
import { useCurrentPage } from '@/components/useCurrentPage';
import { openDashboard } from '@/lib/compat';
import { DEFAULT_SHORTCUTS } from '@/lib/constants';
import { notesToMarkdownReport } from '@/lib/format';
import { sendToTab } from '@/lib/messages';
import { displayPageKey } from '@/lib/url';
import { EmptyPage } from './EmptyPage';
import { NotesView } from './NotesView';

const UNREACHABLE = "Couldn't reach the page. Try reloading it.";

export function App() {
  const page = useCurrentPage();
  const [settings, updateSettings, settingsReady] = useSettings();
  const shortcut = useCommandShortcut('start-picker', DEFAULT_SHORTCUTS.startPicker);
  const toast = useToast();
  const canPick = page.status === 'ready';

  const startPicker = async () => {
    if (page.tabId === undefined) return;
    const res = await sendToTab(page.tabId, { type: 'wm:start-picker' });
    if (!res) {
      toast(UNREACHABLE, { tone: 'danger' });
      page.refreshPageState();
    }
  };

  const copyReport = async () => {
    let ok = false;
    try {
      const title = page.title || (page.pageKey ? displayPageKey(page.pageKey) : undefined);
      ok = await copyText(notesToMarkdownReport(page.notes, { title }));
    } catch {
      ok = false;
    }
    toast(ok ? 'Page report copied as Markdown' : "Couldn't copy the report", { tone: ok ? 'success' : 'danger' });
  };

  const openAllNotes = () => {
    openDashboard().catch(() => toast("Couldn't open the dashboard", { tone: 'danger' }));
  };

  let body;
  if (page.status === 'restricted') {
    body = (
      <div className="sp-body">
        <RestrictedPageNotice>
          <Button variant="secondary" icon={<IconLayoutGrid size={14} />} onClick={openAllNotes}>
            All notes
          </Button>
        </RestrictedPageNotice>
      </div>
    );
  } else if (page.status === 'missing') {
    body = (
      <div className="sp-body">
        <MissingScriptNotice tabId={page.tabId} url={page.url} />
      </div>
    );
  } else if (page.notes.length && page.pageKey) {
    // Also while the page reloads: notes come from storage, only locating needs the page.
    body = <NotesView key={page.pageKey} page={page} />;
  } else if (page.status === 'ready' && !page.notesLoading) {
    body = <EmptyPage shortcut={shortcut} onAdd={() => void startPicker()} />;
  } else {
    body = (
      <div className="sp-body sp-loading" role="status">
        <div className="wm-spinner" />
        <span>{page.tab?.status === 'loading' ? 'Waiting for the page to load…' : 'Connecting to the page…'}</span>
      </div>
    );
  }

  return (
    <div className="sp">
      <header className="sp-header">
        <div className="sp-header__page">
          <Logo size={20} />
          <div className="sp-header__text">
            <h1 className="sp-header__title" title={page.title}>
              {page.title || page.site || 'WebMark'}
            </h1>
            {page.pageKey || page.url ? (
              <p className="sp-header__url" title={page.url}>
                {page.pageKey ? displayPageKey(page.pageKey) : page.url}
              </p>
            ) : null}
          </div>
        </div>
        <div className="sp-header__actions">
          <Button
            variant="primary"
            size="sm"
            icon={<IconPlus size={14} />}
            onClick={() => void startPicker()}
            disabled={!canPick}
            title={shortcut ? `Add note (${shortcut})` : 'Add note'}
            aria-keyshortcuts={shortcut.includes('+') ? shortcut.replace(/\s/g, '') : undefined}
          >
            Add note
          </Button>
          <Switch
            checked={settings.pinsVisible}
            onChange={(visible) => void updateSettings({ pinsVisible: visible })}
            label="Pins"
            labelFirst
            disabled={!settingsReady}
            title="Show numbered pins on the page"
          />
        </div>
      </header>

      {body}

      <footer className="sp-footer">
        <Button
          variant="secondary"
          size="sm"
          icon={<IconCopy size={14} />}
          onClick={() => void copyReport()}
          disabled={!page.notes.length}
        >
          Copy page report
        </Button>
        <Button variant="ghost" size="sm" icon={<IconLayoutGrid size={14} />} onClick={openAllNotes}>
          All notes
        </Button>
      </footer>
      <Toaster />
    </div>
  );
}
