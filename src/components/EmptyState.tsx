import type { ReactNode } from 'react';
import { cx } from './cx';

export interface EmptyStateProps {
  /** Shown in a soft accent tile above the title. */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Action buttons under the text. */
  children?: ReactNode;
  /** 'warning' tints the icon tile amber (errors, restricted pages). */
  tone?: 'default' | 'warning';
  /** Less padding, for small containers like the popup. */
  compact?: boolean;
  className?: string;
}

export function EmptyState({ icon, title, description, children, tone = 'default', compact, className }: EmptyStateProps) {
  return (
    <div className={cx('wm-empty', compact && 'wm-empty--compact', tone === 'warning' && 'wm-empty--warning', className)}>
      {icon ? <div className="wm-empty__icon">{icon}</div> : null}
      <p className="wm-empty__title">{title}</p>
      {description ? <div className="wm-empty__desc">{description}</div> : null}
      {children ? <div className="wm-empty__actions">{children}</div> : null}
    </div>
  );
}
