import type { NoteStatus } from '@/lib/types';
import { cx } from './cx';

export type BadgeStatus = NoteStatus | 'missing';

const STATUS_TEXT: Record<BadgeStatus, string> = {
  open: 'Open',
  resolved: 'Resolved',
  missing: 'Not found',
};

export interface StatusBadgeProps {
  /** 'missing' = the note's element was not found on the page. */
  status: BadgeStatus;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  return <span className={cx('wm-status', `wm-status--${status}`, className)}>{STATUS_TEXT[status]}</span>;
}
