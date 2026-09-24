import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/Button';
import { IconSettings } from '@/components/icons';
import { EmptyState } from '@/components/EmptyState';
import { useAllNotes } from '@/components/hooks';
import { Logo } from '@/components/Logo';
import { NoteCard } from '@/components/NoteCard';
import { Toaster } from '@/components/Toaster';
import { revealNote } from '@/lib/compat';
import { DEFAULT_SHORTCUTS, pinNumber } from '@/lib/constants';
import { deleteNote, updateNote } from '@/lib/storage';
import type { Note } from '@/lib/types';
import { displayPageKey } from '@/lib/url';
import { DataActions } from './DataActions';
import { SettingsPanel } from './SettingsPanel';

/*
 * "All notes" page: every note grouped by page, search, export/import and
 * settings. Status/tag filters and bulk actions come with the full dashboard.
 */

interface PageGroup {
  pageKey: string;
  title: string;
  /** Oldest first, so pin numbers match the in-page pins. */
  notes: Note[];
}

function matches(note: Note, query: string): boolean {
  if (!query) return true;
  const haystack = [note.label, note.body, note.pageTitle, note.url, ...note.tags].join('\n').toLowerCase();
  return haystack.includes(query);
}

function groupByPage(notes: Note[]): PageGroup[] {
  const groups = new Map<string, PageGroup>();
  for (const note of notes) {
    const group = groups.get(note.pageKey) ?? { pageKey: note.pageKey, title: note.pageTitle, notes: [] };
    group.notes.push(note);
    groups.set(note.pageKey, group);
  }
  for (const group of groups.values()) group.notes.sort((a, b) => a.createdAt - b.createdAt);
  // Most recently active page first.
  return [...groups.values()].sort(
    (a, b) => Math.max(...b.notes.map((n) => n.updatedAt)) - Math.max(...a.notes.map((n) => n.updatedAt)),
  );
}

/** '#welcome' after install, '#note=<id>' from pins/badges, '#settings'. */
function readHash() {
  const hash = location.hash;
  const noteId = hash.startsWith('#note=') ? decodeURIComponent(hash.slice('#note='.length)) : undefined;
  return { welcome: hash === '#welcome', settings: hash === '#settings', noteId };
}

function clearHash() {
  history.replaceState(null, '', location.pathname + location.search);
}

export function App() {
  const [route, setRoute] = useState(readHash);
  const [showSettings, setShowSettings] = useState(route.settings);

  useEffect(() => {
    const onHash = () => {
      const next = readHash();
      setRoute(next);
      if (next.settings) setShowSettings(true);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const { notes, loading } = useAllNotes();
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();

  // Pin numbers come from the full page list, not the filtered one.
  const allGroups = useMemo(() => groupByPage(notes), [notes]);
  const visibleGroups = useMemo(
    () =>
      allGroups
        .map((group) => ({ ...group, visible: group.notes.filter((n) => matches(n, normalizedQuery)) }))
        .filter((group) => group.visible.length > 0),
    [allGroups, normalizedQuery],
  );

  const openCount = notes.filter((n) => n.status === 'open').length;
  const filteredNotes = normalizedQuery ? visibleGroups.flatMap((g) => g.visible) : null;

  // Scroll a deep-linked note into view once it has rendered.
  useEffect(() => {
    if (!route.noteId || loading) return;
    document.getElementById(`note-${route.noteId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [route.noteId, loading]);

  return (
    <div className="wm-allnotes">
      <header className="wm-allnotes__header">
        <div className="wm-allnotes__brand">
          <Logo size={28} />
          <div>
            <h1>WebMark</h1>
            <p>
              {notes.length} notes · {openCount} open · {allGroups.length} pages
            </p>
          </div>
        </div>
        <input
          className="wm-allnotes__search"
          type="search"
          placeholder="Search notes, labels, tags, pages…"
          aria-label="Search notes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </header>

      <div className="wm-allnotes__toolbar">
        <DataActions notes={notes} filtered={filteredNotes} />
        <Button
          size="sm"
          variant={showSettings ? 'secondary' : 'ghost'}
          icon={<IconSettings />}
          aria-expanded={showSettings}
          onClick={() => setShowSettings((v) => !v)}
        >
          Settings
        </Button>
      </div>
      {showSettings ? <SettingsPanel /> : null}

      {route.welcome ? (
        <section className="wm-allnotes__welcome" aria-label="Welcome">
          <h2>Welcome to WebMark</h2>
          <ol>
            <li>
              On any website press <kbd>{DEFAULT_SHORTCUTS.startPicker}</kbd>, or right-click an element and choose
              “Add WebMark note to this element”.
            </li>
            <li>Hover to highlight, press ↑ to select the parent (e.g. the whole card), then click.</li>
            <li>Write your note and press Ctrl+Enter. A numbered pin marks it every time you come back.</li>
          </ol>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              clearHash();
              setRoute(readHash());
            }}
          >
            Got it
          </Button>
        </section>
      ) : null}

      <main className="wm-allnotes__main">
        {loading ? null : notes.length === 0 ? (
          <EmptyState
            title="No notes yet"
            description={`Open any website, press ${DEFAULT_SHORTCUTS.startPicker} (or right-click → "Add WebMark note to this element"), pick an element and write your note.`}
          />
        ) : visibleGroups.length === 0 ? (
          <EmptyState title="No matching notes" description="Try a different search." />
        ) : (
          visibleGroups.map((group) => (
            <section key={group.pageKey} className="wm-allnotes__page">
              <div className="wm-allnotes__page-header">
                <h2 title={group.title}>{group.title || displayPageKey(group.pageKey)}</h2>
                <span className="wm-allnotes__page-url">{displayPageKey(group.pageKey)}</span>
              </div>
              <div className="wm-allnotes__list">
                {group.visible.map((note) => (
                  <div key={note.id} id={`note-${note.id}`}>
                    <NoteCard
                      note={note}
                      highlighted={note.id === route.noteId}
                      pinNumber={pinNumber(note.id, group.notes)}
                      onLocate={() => void revealNote(note)}
                      locateLabel="Open on page"
                      onUpdate={(patch) => updateNote(note.pageKey, note.id, patch)}
                      onDelete={() => deleteNote(note.pageKey, note.id)}
                    />
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
      </main>
      <Toaster />
    </div>
  );
}
