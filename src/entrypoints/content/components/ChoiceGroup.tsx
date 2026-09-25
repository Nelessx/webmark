import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface Choice<T extends string> {
  value: T;
  label: string;
  /** Decorative lead: a status dot, priority bars. */
  icon?: ReactNode;
}

interface ChoiceGroupProps<T extends string> {
  /** Id of the visible label that names the group. */
  labelledBy: string;
  choices: readonly Choice<T>[];
  value: T;
  onChange(value: T): void;
  /**
   * Styling and test hook: the group gets data-wm-<name>="<value>", each
   * choice data-wm-<name>-option="<its value>".
   */
  name: 'status' | 'priority';
}

/**
 * Segmented single choice for the note editor: a radio group with one tab
 * stop, where the arrow keys (and Home/End) move the choice.
 */
export function ChoiceGroup<T extends string>({ labelledBy, choices, value, onChange, name }: ChoiceGroupProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);

  const choose = (index: number) => {
    const count = choices.length;
    const at = ((index % count) + count) % count;
    const choice = choices[at];
    if (!choice) return;
    onChange(choice.value);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[at]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = choices.findIndex((c) => c.value === value);
    const moves: Record<string, number> = {
      ArrowRight: current + 1,
      ArrowDown: current + 1,
      ArrowLeft: current - 1,
      ArrowUp: current - 1,
      Home: 0,
      End: choices.length - 1,
    };
    const next = moves[event.key];
    if (next === undefined || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    choose(next);
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-labelledby={labelledBy}
      className="wm-segmented wm-editor__choices"
      {...{ [`data-wm-${name}`]: value }}
      onKeyDown={onKeyDown}
    >
      {choices.map((choice) => {
        const checked = choice.value === value;
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className="wm-segmented__option"
            {...{ [`data-wm-${name}-option`]: choice.value }}
            onClick={() => onChange(choice.value)}
          >
            {choice.icon}
            <span>{choice.label}</span>
          </button>
        );
      })}
    </div>
  );
}
