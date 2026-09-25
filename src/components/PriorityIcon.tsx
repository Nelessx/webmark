import { NOTE_PRIORITIES, priorityRank } from '@/lib/noteMeta';
import type { NotePriority } from '@/lib/types';

export interface PriorityIconProps {
  priority: NotePriority;
  size?: number;
  className?: string;
}

/**
 * Signal bars, filled to the priority: one bar for low, two for medium, three
 * for high. Drawn in currentColor; always decorative (say the priority in
 * text next to it). No stylesheet needed, so the in-page UI uses it too.
 */
export function PriorityIcon({ priority, size = 12, className }: PriorityIconProps) {
  const filled = NOTE_PRIORITIES.length - priorityRank(priority);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 12 12"
      className={className ? `wm-priority-icon ${className}` : 'wm-priority-icon'}
      data-level={filled}
      aria-hidden="true"
      focusable="false"
    >
      {[0, 1, 2].map((bar) => (
        <rect
          key={bar}
          x={0.75 + bar * 4}
          y={7.5 - bar * 3}
          width={2.5}
          height={3.5 + bar * 3}
          rx={0.75}
          fill="currentColor"
          opacity={bar < filled ? 1 : 0.3}
        />
      ))}
    </svg>
  );
}
