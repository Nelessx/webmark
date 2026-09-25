import { NOTE_PRIORITIES, NOTE_STATUSES, PRIORITY_LABELS, STATUS_LABELS } from '@/lib/noteMeta';
import type { PriorityCounts, PriorityFilter, StatusCounts, StatusFilter } from './filter';
import { PriorityIcon } from './PriorityIcon';
import type { SegmentedOption } from './Segmented';
import { StatusDot } from './StatusBadge';

/** "All" (every status but archived), then each status with its dot and count. */
export function statusFilterOptions(counts: StatusCounts): SegmentedOption<StatusFilter>[] {
  return [
    { value: 'all', label: 'All', count: counts.all },
    ...NOTE_STATUSES.map((status) => ({
      value: status,
      label: (
        <>
          <StatusDot status={status} />
          {STATUS_LABELS[status]}
        </>
      ),
      count: counts[status],
    })),
  ];
}

/** "All", then each priority (most urgent first) with its signal bars and count. */
export function priorityFilterOptions(counts: PriorityCounts): SegmentedOption<PriorityFilter>[] {
  return [
    { value: 'all', label: 'All', count: counts.all },
    ...NOTE_PRIORITIES.map((priority) => ({
      value: priority,
      label: (
        <>
          <span className="wm-priority-mark" data-priority={priority}>
            <PriorityIcon priority={priority} />
          </span>
          {PRIORITY_LABELS[priority]}
        </>
      ),
      count: counts[priority],
    })),
  ];
}
