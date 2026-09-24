import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import {
  collectTags,
  countByStatus,
  noteHasTags,
  noteMatchesQuery,
  noteMatchesStatus,
  type StatusFilter,
} from '@/components/filter';
import { useToast } from '@/components/hooks';
import { IconSearch } from '@/components/icons';
import { NoteCard } from '@/components/NoteCard';
import { SearchInput } from '@/components/SearchInput';
import { Segmented } from '@/components/Segmented';
import { TagList } from '@/components/TagList';
import type { CurrentPage } from '@/components/useCurrentPage';
import { pinNumber } from '@/lib/constants';
import { sendToTab } from '@/lib/messages';
import { deleteNote, updateNote } from '@/lib/storage';
import type { Note } from '@/lib/types';

const UNREACHABLE = "Couldn't reach the page. Try reloading it.";

interface NotesViewProps {
  /** Must have notes and a pageKey. Remount (key) per page to reset filters. */
  page: CurrentPage;
}

/** Search, status and tag filters over the page's notes, with found / not-found groups. */
export function NotesView({ page }: NotesViewProps) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocuses(searchRef);

  const tagCounts = useMemo(() => collectTags(page.notes), [page.notes]);
  // Ignore selected tags that no longer exist (e.g. removed in an edit).
  const activeTags = useMemo(
    () => selectedTags.filter((tag) => tagCounts.some((t) => t.tag === tag)),
    [selectedTags, tagCounts],
  );
  const searched = useMemo(
    () => page.notes.filter((n) => noteMatchesQuery(n, query) && noteHasTags(n, activeTags)),
    [page.notes, query, activeTags],
  );
  const counts = countByStatus(searched);
  const visible = searched.filter((n) => noteMatchesStatus(n, status));
  const found = visible.filter((n) => !page.orphanedIds.has(n.id));
  const orphaned = visible.filter((n) => page.orphanedIds.has(n.id));

  const toggleTag = (tag: string) =>
    setSelectedTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  const clearFilters = () => {
    setQuery('');
    setStatus('all');
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

  return (
    <>
      <div className="sp-toolbar">
        <SearchInput ref={searchRef} value={query} onChange={setQuery} placeholder="Search notes" hint="/" />
        <Segmented
          label="Filter by status"
          block
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
            className="sp-toolbar__tags"
            label="Filter by tag"
            tags={tagCounts.map((t) => t.tag)}
            onTagClick={toggleTag}
            activeTags={activeTags}
          />
        ) : null}
      </div>

      <main className="sp-list" aria-label="Notes on this page">
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
              resolve them.
            </p>
            {orphaned.map(renderCard)}
          </section>
        ) : null}

        {!visible.length ? (
          <EmptyState compact icon={<IconSearch size={20} />} title="No notes match" description="Try another search or filter.">
            <Button size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          </EmptyState>
        ) : null}
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
