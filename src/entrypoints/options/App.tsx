import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/Button';
import { IconSettings } from '@/components/icons';
import { EmptyState } from '@/components/EmptyState';
import {
  collectTags,
  countByStatus,
  noteHasTags,
  noteMatchesQuery,
  noteMatchesStatus,
  type StatusFilter,
} from '@/components/filter';
import { useAllNotes } from '@/components/hooks';
import { Segmented } from '@/components/Segmented';
import { TagList } from '@/components/TagList';
import { Logo } from '@/components/Logo';
import { NoteCard } from '@/components/NoteCard';
import { Toaster } from '@/components/Toaster';
import { showToast } from '@/components/toast';
import { revealNote } from '@/lib/compat';
import { DEFAULT_SHORTCUTS, pinNumber } from '@/lib/constants';
import { deleteNote, updateNote } from '@/lib/storage';
import type { Note } from '@/lib/types';
import { displayPageKey } from '@/lib/url';
import { BulkBar } from './BulkBar';
import { DataActions } from './DataActions';
import { SettingsPanel } from './SettingsPanel';

/*
 * "All notes" page: every note grouped by page, with search, status and tag
 * filters, bulk actions, export/import and settings.
 */

interface PageGroup {
  pageKey: string;
  title: string;
  /** Oldest first, so pin numbers match the in-page pins. */
  notes: Note[];
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
  const [status, setStatus] = useState<StatusFilter>('all');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  const tagCounts = useMemo(() => collectTags(notes), [notes]);
  // Ignore selected tags that no longer exist (e.g. removed in an edit).
  const activeTags = useMemo(
    () => selectedTags.filter((tag) => tagCounts.some((t) => t.tag === tag)),
    [selectedTags, tagCounts],
  );
  const toggleTag = (tag: string) =>
    setSelectedTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  // Status counts reflect the search and tag filters, like the side panel.
  const searched = useMemo(
    () => notes.filter((n) => noteMatchesQuery(n, query) && noteHasTags(n, activeTags)),
    [notes, query, activeTags],
  );
  const counts = countByStatus(searched);

  // Pin numbers come from the full page list, not the filtered one.
  const allGroups = useMemo(() => groupByPage(notes), [notes]);
  const visibleGroups = useMemo(() => {
    const shown = new Set(searched.filter((n) => noteMatchesStatus(n, status)).map((n) => n.id));
    return allGroups
      .map((group) => ({ ...group, visible: group.notes.filter((n) => shown.has(n.id)) }))
      .filter((group) => group.visible.length > 0);
  }, [allGroups, searched, status]);

  const openCount = notes.filter((n) => n.status === 'open').length;
  const filtersActive = query.trim() !== '' || status !== 'all' || activeTags.length > 0;
  const filteredNotes = filtersActive ? visibleGroups.flatMap((g) => g.visible) : null;

  const clearFilters = () => {
    setQuery('');
    setStatus('all');
    setSelectedTags([]);
  };

  // Bulk selection only ever covers notes that are currently shown.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const shownNotes = useMemo(() => visibleGroups.flatMap((g) => g.visible), [visibleGroups]);
  const selectedNotes = useMemo(() => shownNotes.filter((n) => selectedIds.has(n.id)), [shownNotes, selectedIds]);
  const setSelected = (id: string, on: boolean) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

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

      {notes.length ? (
        <div className="wm-allnotes__filters">
          <Segmented
            label="Filter by status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'All', count: counts.all },
              { value: 'open', label: 'Open', count: counts.open },
              { value: 'resolved', label: 'Resolved', count: counts.resolved },
            ]}
          />
          {tagCounts.length ? (
            <TagList
              label="Filter by tag"
              tags={tagCounts.map((t) => t.tag)}
              counts={Object.fromEntries(tagCounts.map((t) => [t.tag, t.count]))}
              onTagClick={toggleTag}
              activeTags={activeTags}
            />
          ) : null}
          {filtersActive ? (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}

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

      {selectedNotes.length ? (
        <BulkBar
          selected={selectedNotes}
          shownCount={shownNotes.length}
          onSelectAll={() => setSelectedIds(new Set(shownNotes.map((n) => n.id)))}
          onClear={() => setSelectedIds(new Set())}
        />
      ) : null}

      <main className="wm-allnotes__main">
        {loading ? null : notes.length === 0 ? (
          <EmptyState
            title="No notes yet"
            description={`Open any website, press ${DEFAULT_SHORTCUTS.startPicker} (or right-click → "Add WebMark note to this element"), pick an element and write your note.`}
          />
        ) : visibleGroups.length === 0 ? (
          <EmptyState title="No matching notes" description="Try a different search, status or tag.">
            <Button size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          </EmptyState>
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
                      selectable
                      selected={selectedIds.has(note.id)}
                      onSelectChange={(on) => setSelected(note.id, on)}
                      pinNumber={pinNumber(note.id, group.notes)}
                      onLocate={() =>
                        void revealNote(note).catch(() =>
                          showToast("Couldn't show this note on its page", { tone: 'danger' }),
                        )
                      }
                      locateLabel="Open on page"
                      onUpdate={(patch) => updateNote(note.pageKey, note.id, patch)}
                      onDelete={() => deleteNote(note.pageKey, note.id)}
                      onTagClick={toggleTag}
                      activeTags={activeTags}
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
