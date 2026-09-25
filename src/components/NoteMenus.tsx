import { NOTE_PRIORITIES, NOTE_STATUSES, PRIORITY_LABELS, STATUS_LABELS } from '@/lib/noteMeta';
import type { NotePriority, NoteStatus } from '@/lib/types';
import { MenuButton, type MenuOption } from './MenuButton';
import { PriorityIcon } from './PriorityIcon';
import { StatusDot } from './StatusBadge';

/** Every status, in workflow order, each with its colour dot. */
export const STATUS_MENU_OPTIONS: readonly MenuOption<NoteStatus>[] = NOTE_STATUSES.map((status) => ({
  value: status,
  label: STATUS_LABELS[status],
  icon: <StatusDot status={status} />,
}));

/** Every priority, most urgent first, each with its signal bars. */
export const PRIORITY_MENU_OPTIONS: readonly MenuOption<NotePriority>[] = NOTE_PRIORITIES.map((priority) => ({
  value: priority,
  label: PRIORITY_LABELS[priority],
  icon: (
    <span className="wm-priority-mark" data-priority={priority}>
      <PriorityIcon priority={priority} />
    </span>
  ),
}));

/** Extra data-* attributes for a menu's button. */
type DataAttributes = Readonly<Record<`data-${string}`, string>>;

export interface StatusMenuProps {
  status: NoteStatus;
  onChange: (status: NoteStatus) => void;
  disabled?: boolean;
  data?: DataAttributes;
}

/** The note's status pill; clicking it offers every status. */
export function StatusMenu({ status, onChange, disabled, data }: StatusMenuProps) {
  return (
    <MenuButton
      label={`Status: ${STATUS_LABELS[status]}`}
      menuLabel="Status"
      className="wm-status"
      data={{ ...data, 'data-status': status }}
      value={status}
      options={STATUS_MENU_OPTIONS}
      onSelect={onChange}
      disabled={disabled}
    >
      {STATUS_LABELS[status]}
    </MenuButton>
  );
}

export interface PriorityMenuProps {
  priority: NotePriority;
  onChange: (priority: NotePriority) => void;
  disabled?: boolean;
  data?: DataAttributes;
}

/** The note's priority chip; clicking it offers every priority. */
export function PriorityMenu({ priority, onChange, disabled, data }: PriorityMenuProps) {
  return (
    <MenuButton
      label={`Priority: ${PRIORITY_LABELS[priority]}`}
      menuLabel="Priority"
      className="wm-priority"
      data={{ ...data, 'data-priority': priority }}
      value={priority}
      options={PRIORITY_MENU_OPTIONS}
      onSelect={onChange}
      disabled={disabled}
    >
      <PriorityIcon priority={priority} />
      <span>{PRIORITY_LABELS[priority]}</span>
    </MenuButton>
  );
}
