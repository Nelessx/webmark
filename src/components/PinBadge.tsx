import type { NoteStatus } from '@/lib/types';
import { cx } from './cx';

export type PinBadgeSize = 'sm' | 'md' | 'lg';

export interface PinBadgeProps {
  /** 1-based pin number from pinNumber(). 0 (not found) renders "?". */
  number: number;
  status?: NoteStatus;
  /** Grey pin for notes whose element is not on the page. */
  orphaned?: boolean;
  size?: PinBadgeSize;
  /** When set, the badge is a button (e.g. "Show #3 on page"). */
  onClick?: () => void;
  /** Accessible name / tooltip. Defaults to "Note #n". */
  label?: string;
  className?: string;
}

/** Numbered circle matching the in-page pins: status colour, white ring. */
export function PinBadge({ number, status = 'open', orphaned, size = 'md', onClick, label, className }: PinBadgeProps) {
  const classes = cx('wm-pin', `wm-pin--${size}`, orphaned ? 'wm-pin--orphaned' : `wm-pin--${status}`, className);
  const text = number > 0 ? String(number) : '?';
  const name = label ?? `Note #${text}`;
  if (onClick) {
    return (
      <button type="button" className={classes} onClick={onClick} aria-label={name} title={name}>
        {text}
      </button>
    );
  }
  return (
    <span className={classes} title={name}>
      {text}
    </span>
  );
}
