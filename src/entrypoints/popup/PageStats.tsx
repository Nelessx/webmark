import { countByStatus } from '@/components/filter';
import type { Note } from '@/lib/types';

interface PageStatsProps {
  notes: Note[];
  orphanedIds: ReadonlySet<string>;
}

/** Open / resolved / not-found counts for the current page. */
export function PageStats({ notes, orphanedIds }: PageStatsProps) {
  const { open, resolved } = countByStatus(notes);
  const missing = notes.filter((n) => orphanedIds.has(n.id)).length;

  return (
    <dl className="popup-stats" aria-label="Notes on this page">
      <Stat value={open} label="Open" kind="open" />
      <Stat value={resolved} label="Resolved" kind="resolved" />
      <Stat value={missing} label="Not found" kind={missing ? 'missing' : 'none'} />
    </dl>
  );
}

function Stat({ value, label, kind }: { value: number; label: string; kind: 'open' | 'resolved' | 'missing' | 'none' }) {
  return (
    <div className={`popup-stat popup-stat--${kind}`}>
      <dt className="popup-stat__label">{label}</dt>
      <dd className="popup-stat__value">{value}</dd>
    </div>
  );
}
