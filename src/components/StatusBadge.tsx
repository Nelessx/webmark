import { STATUS_LABELS } from '@/lib/noteMeta';
import type { NoteStatus } from '@/lib/types';
import { cx } from './cx';

export type BadgeStatus = NoteStatus | 'missing';

const BADGE_TEXT: Readonly<Record<BadgeStatus, string>> = { ...STATUS_LABELS, missing: 'Not found' };

export interface StatusBadgeProps {
  /** 'missing' = the note's element was not found on the page. */
  status: BadgeStatus;
  className?: string;
}

/** A status as a tinted pill: coloured dot + label. */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <span className={cx('wm-status', className)} data-status={status}>
      {BADGE_TEXT[status]}
    </span>
  );
}

export interface StatusDotProps {
  status: BadgeStatus;
  className?: string;
}

/** Just the status colour (decorative: say the status in text nearby). */
export function StatusDot({ status, className }: StatusDotProps) {
  return <span className={cx('wm-dot', className)} data-status={status} aria-hidden="true" />;
}
