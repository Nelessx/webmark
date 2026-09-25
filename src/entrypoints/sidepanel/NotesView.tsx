import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import {
  collectTags,
  filterNotes,
  filtersActive,
  type NoteFilters,
  type PriorityFilter,
  type StatusFilter,
} from '@/components/filter';
import { priorityFilterOptions, statusFilterOptions } from '@/components/filterOptions';
import { useToast } from '@/components/hooks';
import { IconSearch } from '@/components/icons';
import { NoteCard } from '@/components/NoteCard';
import { SearchInput } from '@/components/SearchInput';
import { Segmented } from '@/components/Segmented';
import { TagList } from '@/components/TagList';
import type { CurrentPage } from '@/components/useCurrentPage';
import { useFocusKeeper } from '@/components/useFocusKeeper';
import { pinNumber } from '@/lib/constants';
import { sendToTab } from '@/lib/messages';
import { deleteNote, updateNote } from '@/lib/storage';
import type { Note } from '@/lib/types';

const UNREACHABLE = "Couldn't reach the page. Try reloading it.";

interface NotesViewProps {
  /** Must have notes and a pageKey. Remount (key) per page to reset filters. */
  page: CurrentPage;
}

/**
 * Search, status, priority and tag filters over the page's notes, with found
 * / not-found groups. "All" leaves archived notes out; they are listed under
 * "Archived" only.
 */
export function NotesView({ page }: NotesViewProps) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [priority, setPriority] = useState<PriorityFilter>('all');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);
  useSlashFocuses(searchRef);

  const tagCounts = useMemo(() => collectTags(page.notes), [page.notes]);
  // Ignore selected tags that no longer exist (e.g. removed in an edit).
  const activeTags = useMemo(
    () => selectedTags.filter((tag) => tagCounts.some((t) => t.tag === tag)),
    [selectedTags, tagCounts],
  );
  const filters = useMemo<NoteFilters>(
    () => ({ query, tags: activeTags, status, priority }),
    [query, activeTags, status, priority],
  );
  const { visible, statusCounts, priorityCounts } = useMemo(() => filterNotes(page.notes, filters), [page.notes, filters]);
  // Archived notes are never in orphanedIds: they have no pin to miss.
  const found = visible.filter((n) => !page.orphanedIds.has(n.id));
  const orphaned = visible.filter((n) => page.orphanedIds.has(n.id));
  const narrowed = filtersActive(filters);
  // A card that leaves the list (archived, say) hands keyboard focus to the one in its place.
  useFocusKeeper(listRef, [...found, ...orphaned].map((n) => n.id));

  const toggleTag = (tag: string) =>
    setSelectedTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  const clearFilters = () => {
    setQuery('');
    setStatus('all');
    setPriority('all');
    setSelectedTags([]);
  };

  const locate = async (note: Note) => {
    if (page.tabId === undefined) return;
    const res = await sendToTab(page.tabId, { type: 'wm:focus-note', noteId: note.id });
    if (!res) toast(UNREACHABLE, { tone: 'danger' });
    else if (!res.found) toast("This note's element isn't on the page right now");
  };

  const renderCard = (note: Note) => (
    <NoteCard
      key={note.id}
      note={note}
      pinNumber={pinNumber(note.id, page.notes)}
      orphaned={page.orphanedIds.has(note.id)}
      onLocate={() => void locate(note)}
      onUpdate={(patch) => updateNote(note.pageKey, note.id, patch)}
      onDelete={() => deleteNote(note.pageKey, note.id)}
      onTagClick={toggleTag}
      activeTags={activeTags}
    />
  );

  let empty = null;
  if (!visible.length) {
    empty =
      !narrowed && statusCounts.archived > 0 ? (
        <EmptyState
          compact
          icon={<IconSearch size={20} />}
          title="All notes on this page are archived"
          description="Archived notes stay out of the list and have no pins."
        >
          <Button size="sm" onClick={() => setStatus('archived')}>
            Show archived
          </Button>
        </EmptyState>
      ) : (
        <EmptyState compact icon={<IconSearch size={20} />} title="No notes match" description="Try another search or filter.">
          <Button size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        </EmptyState>
      );
  }

  return (
    <>
      <div className="sp-toolbar">
        <SearchInput ref={searchRef} value={query} onChange={setQuery} placeholder="Search notes" hint="/" />
        <Segmented
          label="Filter by status"
          variant="chips"
          value={status}
          onChange={setStatus}
          options={statusFilterOptions(statusCounts)}
        />
        <Segmented
          label="Filter by priority"
          variant="chips"
          value={priority}
          onChange={setPriority}
          options={priorityFilterOptions(priorityCounts)}
        />
        {tagCounts.length ? (
          <TagList
            className="sp-toolbar__tags"
            label="Filter by tag"
            tags={tagCounts.map((t) => t.tag)}
            onTagClick={toggleTag}
            activeTags={activeTags}
          />
        ) : null}
        {narrowed ? (
          <button type="button" className="wm-link-btn sp-toolbar__clear" onClick={clearFilters}>
            Clear filters
          </button>
        ) : null}
      </div>

      <main ref={listRef} className="sp-list" aria-label="Notes on this page" tabIndex={-1}>
        {found.map(renderCard)}

        {orphaned.length ? (
          <section className="sp-orphans" aria-labelledby="sp-orphans-title">
            <div className="sp-orphans__head">
              <h2 id="sp-orphans-title" className="wm-section-title">
                Not found on this page
              </h2>
              <span className="sp-orphans__count">{orphaned.length}</span>
            </div>
            <p className="sp-orphans__hint">
              The page changed and these elements couldn't be matched. The notes are kept so you can review, edit or
              complete them.
            </p>
            {orphaned.map(renderCard)}
          </section>
        ) : null}

        {empty}
      </main>
    </>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** "/" anywhere outside a text field focuses the search box. */
function useSlashFocuses(ref: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) return;
      event.preventDefault();
      ref.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [ref]);
}
