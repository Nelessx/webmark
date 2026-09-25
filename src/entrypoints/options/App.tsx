import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import {
  collectTags,
  countByStatus,
  filterNotes,
  filtersActive,
  isNoteSort,
  NOTE_SORTS,
  SORT_LABELS,
  sortNotes,
  type NoteFilters,
  type NoteSort,
  type PriorityFilter,
  type StatusFilter,
} from '@/components/filter';
import { priorityFilterOptions, statusFilterOptions } from '@/components/filterOptions';
import { useAllNotes } from '@/components/hooks';
import { IconSettings } from '@/components/icons';
import { Logo } from '@/components/Logo';
import { NoteCard, type CardControl } from '@/components/NoteCard';
import { PriorityIcon } from '@/components/PriorityIcon';
import { Segmented } from '@/components/Segmented';
import { StatusDot } from '@/components/StatusBadge';
import { TagList } from '@/components/TagList';
import { Toaster } from '@/components/Toaster';
import { showToast } from '@/components/toast';
import { useFocusKeeper } from '@/components/useFocusKeeper';
import { revealNote } from '@/lib/compat';
import { DEFAULT_SHORTCUTS, pinNumber } from '@/lib/constants';
import { isArchivedStatus, NOTE_STATUSES, STATUS_LABELS } from '@/lib/noteMeta';
import { deleteNote, updateNote } from '@/lib/storage';
import type { Note } from '@/lib/types';
import { displayPageKey } from '@/lib/url';
import { BulkBar } from './BulkBar';
import { DataActions } from './DataActions';
import { SettingsPanel } from './SettingsPanel';

/*
 * "All notes" page: every note grouped by page, with search, status,
 * priority and tag filters, sorting, bulk actions, export/import and
 * settings. Archived notes are left out unless the Archived filter is on.
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

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

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
  const [priority, setPriority] = useState<PriorityFilter>('all');
  const [sort, setSort] = useState<NoteSort>('pin');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  const tagCounts = useMemo(() => collectTags(notes), [notes]);
  // Ignore selected tags that no longer exist (e.g. removed in an edit).
  const activeTags = useMemo(
    () => selectedTags.filter((tag) => tagCounts.some((t) => t.tag === tag)),
    [selectedTags, tagCounts],
  );
  const toggleTag = (tag: string) =>
    setSelectedTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  // Each filter's counts reflect the other filters, like the side panel.
  const filters = useMemo<NoteFilters>(
    () => ({ query, tags: activeTags, status, priority }),
    [query, activeTags, status, priority],
  );
  const { visible, statusCounts, priorityCounts } = useMemo(() => filterNotes(notes, filters), [notes, filters]);
  const narrowed = filtersActive(filters);

  // Pin numbers come from the full page list, not the filtered one.
  const allGroups = useMemo(() => groupByPage(notes), [notes]);
  const visibleGroups = useMemo(() => {
    const shown = new Set(visible.map((n) => n.id));
    return allGroups
      .map((group) => ({ ...group, visible: sortNotes(group.notes.filter((n) => shown.has(n.id)), sort) }))
      .filter((group) => group.visible.length > 0);
  }, [allGroups, visible, sort]);

  // Summary over every note: per status, and high priority among those not archived.
  const totals = useMemo(() => countByStatus(notes), [notes]);
  const highCount = useMemo(
    () => notes.filter((n) => n.priority === 'high' && !isArchivedStatus(n.status)).length,
    [notes],
  );

  const clearFilters = () => {
    setQuery('');
    setStatus('all');
    setPriority('all');
    setSelectedTags([]);
  };

  // Bulk selection and reports only ever cover notes that are currently shown.
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

  // A card that leaves the list (archived, say) hands keyboard focus to the one in its place.
  // When the bulk bar goes, focus goes to the first note that was selected, or the one in its place.
  const listRef = useRef<HTMLElement>(null);
  const firstSelected = selectedNotes[0];
  useFocusKeeper(
    listRef,
    shownNotes.map((n) => n.id),
    firstSelected && { cardId: firstSelected.id, control: 'select' satisfies CardControl },
  );

  // A deep-linked archived note is only listed under Archived: switch there once.
  const revealedArchived = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!route.noteId || loading || revealedArchived.current === route.noteId) return;
    const target = notes.find((n) => n.id === route.noteId);
    if (!target) return;
    revealedArchived.current = route.noteId;
    if (isArchivedStatus(target.status)) setStatus('archived');
  }, [route.noteId, loading, notes]);

  // Scroll a deep-linked note into view once it has rendered (a card mounted later scrolls itself).
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
              {plural(notes.length, 'note')} on {plural(allGroups.length, 'page')}
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

      {notes.length ? (
        <ul className="wm-allnotes__stats" aria-label="Summary">
          {NOTE_STATUSES.map((s) => (
            <li key={s} className="wm-allnotes__stat" data-status={s}>
              <StatusDot status={s} />
              <strong>{totals[s]}</strong> {STATUS_LABELS[s].toLowerCase()}
            </li>
          ))}
          <li className="wm-allnotes__stat" data-priority="high" title="High-priority notes that aren't archived">
            <span className="wm-priority-mark" data-priority="high">
              <PriorityIcon priority="high" />
            </span>
            <strong>{highCount}</strong> high priority
          </li>
        </ul>
      ) : null}

      <div className="wm-allnotes__toolbar">
        <DataActions notes={notes} shown={shownNotes} />
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
            options={statusFilterOptions(statusCounts)}
          />
          <Segmented
            label="Filter by priority"
            value={priority}
            onChange={setPriority}
            options={priorityFilterOptions(priorityCounts)}
          />
          <label className="wm-allnotes__sort">
            <span>Sort</span>
            <select
              className="wm-allnotes__select"
              aria-label="Sort notes on each page"
              value={sort}
              onChange={(e) => isNoteSort(e.target.value) && setSort(e.target.value)}
            >
              {NOTE_SORTS.map((value) => (
                <option key={value} value={value}>
                  {SORT_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          {tagCounts.length ? (
            <TagList
              label="Filter by tag"
              tags={tagCounts.map((t) => t.tag)}
              counts={Object.fromEntries(tagCounts.map((t) => [t.tag, t.count]))}
              onTagClick={toggleTag}
              activeTags={activeTags}
            />
          ) : null}
          {narrowed ? (
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

      <main ref={listRef} className="wm-allnotes__main" aria-label="Notes" tabIndex={-1}>
        {selectedNotes.length ? (
          <BulkBar
            selected={selectedNotes}
            shownCount={shownNotes.length}
            onSelectAll={() => setSelectedIds(new Set(shownNotes.map((n) => n.id)))}
            onClear={() => setSelectedIds(new Set())}
          />
        ) : null}
        {loading ? null : notes.length === 0 ? (
          <EmptyState
            title="No notes yet"
            description={`Open any website, press ${DEFAULT_SHORTCUTS.startPicker} (or right-click → "Add WebMark note to this element"), pick an element and write your note.`}
          />
        ) : visibleGroups.length === 0 && !narrowed && statusCounts.archived > 0 ? (
          <EmptyState title="Every note is archived" description="Archived notes stay out of the list until you ask for them.">
            <Button size="sm" onClick={() => setStatus('archived')}>
              Show archived
            </Button>
          </EmptyState>
        ) : visibleGroups.length === 0 ? (
          <EmptyState title="No matching notes" description="Try a different search, status, priority or tag.">
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
