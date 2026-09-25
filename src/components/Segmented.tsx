import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './cx';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Shown as a small number after the label. */
  count?: number;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group, e.g. "Status". */
  label: string;
  /** Stretch items to fill the width. */
  block?: boolean;
  /** 'chips': separate pills that wrap onto more lines, for narrow places (the side panel). */
  variant?: 'tabs' | 'chips';
  className?: string;
}

/** Single-choice filter tabs (radio group; arrow keys move the selection). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  block,
  variant = 'tabs',
  className,
}: SegmentedProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);

  const select = (index: number) => {
    const option = options[(index + options.length) % options.length];
    if (!option) return;
    onChange(option.value);
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[(index + options.length) % options.length]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = options.findIndex((o) => o.value === value);
    const moves: Record<string, number> = {
      ArrowRight: current + 1,
      ArrowDown: current + 1,
      ArrowLeft: current - 1,
      ArrowUp: current - 1,
      Home: 0,
      End: options.length - 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(next);
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      className={cx(
        'wm-segmented',
        block && 'wm-segmented--block',
        variant === 'chips' && 'wm-segmented--chips',
        className,
      )}
      onKeyDown={onKeyDown}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        // Keep one item tabbable even if `value` matches no option.
        const tabbable = checked || (index === 0 && !options.some((o) => o.value === value));
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={tabbable ? 0 : -1}
            className="wm-segmented__item"
            onClick={() => onChange(option.value)}
          >
            <span className="wm-segmented__label">{option.label}</span>
            {/* A flex container drops this space from the layout; it keeps "Open 2" apart in the accessible name. */}
            {option.count !== undefined ? ' ' : null}
            {option.count !== undefined ? <span className="wm-segmented__count">{option.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
