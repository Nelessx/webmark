import { countByStatus } from '@/components/filter';
import { STATUS_LABELS } from '@/lib/noteMeta';
import type { Note, NoteStatus } from '@/lib/types';

interface PageStatsProps {
  /** The page's notes that aren't archived (archived ones aren't counted). */
  notes: Note[];
  orphanedIds: ReadonlySet<string>;
}

/** Open / in progress / completed / not-found counts for the current page. */
export function PageStats({ notes, orphanedIds }: PageStatsProps) {
  const counts = countByStatus(notes);
  const missing = notes.filter((n) => orphanedIds.has(n.id)).length;
  const shown: NoteStatus[] = ['open', 'in_progress', 'completed'];

  return (
    <dl className="popup-stats" aria-label="Notes on this page">
      {shown.map((status) => (
        <Stat key={status} value={counts[status]} label={STATUS_LABELS[status]} status={status} />
      ))}
      <Stat value={missing} label="Not found" status={missing ? 'missing' : 'none'} />
    </dl>
  );
}

function Stat({ value, label, status }: { value: number; label: string; status: NoteStatus | 'missing' | 'none' }) {
  return (
    <div className="popup-stat" data-status={status}>
      <dt className="popup-stat__label">{label}</dt>
      <dd className="popup-stat__value">{value}</dd>
    </div>
  );
}
