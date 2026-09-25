import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './cx';
import { IconCheck, IconChevronDown } from './icons';

export interface MenuOption<T extends string> {
  value: T;
  label: string;
  /** Decorative lead, e.g. a status dot. */
  icon?: ReactNode;
}

export interface MenuButtonProps<T extends string> {
  /** Accessible name (and tooltip) of the button, e.g. "Status: Open" or "Set status". */
  label: string;
  /** Accessible name of the menu. Defaults to `label`. */
  menuLabel?: string;
  /** What the button shows; a chevron is added after it. */
  children: ReactNode;
  options: readonly MenuOption<T>[];
  /** The current choice: the items become radio items with this one checked. */
  value?: T;
  onSelect: (value: T) => void;
  disabled?: boolean;
  /** Class of the button. */
  className?: string;
  /** data-* attributes of the button, for styling (e.g. { 'data-status': 'open' }). */
  data?: Readonly<Record<`data-${string}`, string>>;
}

interface Position {
  left: number;
  top: number;
}

const GAP = 4;
const MARGIN = 8;

/**
 * A button that opens a menu of choices (WAI-ARIA menu button). Two clicks
 * to choose; from the keyboard, Enter/Space/↓ open it, arrows, Home/End and
 * the first letter move, Enter picks, Escape or Tab close it. The menu is
 * fixed to the viewport next to the button, so scrolling lists can't clip it,
 * and closes when anything scrolls.
 */
export function MenuButton<T extends string>({
  label,
  menuLabel,
  children,
  options,
  value,
  onSelect,
  disabled,
  className,
  data,
}: MenuButtonProps<T>) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const [active, setActive] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const radio = value !== undefined;
  const checkedIndex = Math.max(0, options.findIndex((o) => o.value === value));

  const show = (index: number) => {
    setActive(index);
    setOpen(true);
  };

  const hide = (restoreFocus: boolean) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) buttonRef.current?.focus({ preventScroll: true });
  };

  // Below the button, or above it when only that fits; kept inside the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const button = buttonRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!button || !menu) return;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const { offsetWidth: width, offsetHeight: height } = menu;
    const fitsBelow = button.bottom + GAP + height <= viewportHeight - MARGIN;
    const fitsAbove = button.top - GAP - height >= MARGIN;
    const top = fitsBelow || !fitsAbove ? button.bottom + GAP : button.top - GAP - height;
    const left = Math.max(MARGIN, Math.min(button.left, viewportWidth - MARGIN - width));
    setPosition({ left, top: Math.max(MARGIN, top) });
  }, [open]);

  // Focus follows the active item once the menu is placed (a hidden menu can't take focus).
  useEffect(() => {
    if (open && position) itemRefs.current[active]?.focus({ preventScroll: true });
  }, [open, position, active]);

  // Close on a press outside, and when anything scrolls or the window resizes (the menu is fixed).
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (!!menuRef.current?.contains(target) || !!buttonRef.current?.contains(target));
    // The press puts focus where it lands; a scroll or resize would leave it nowhere, so it goes back to the button.
    const focusInMenu = () => !!menuRef.current?.contains(document.activeElement);
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) hide(false);
    };
    const onScroll = (event: Event) => {
      if (!inside(event.target)) hide(focusInMenu());
    };
    const onResize = () => hide(focusInMenu());
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const choose = (option: MenuOption<T>) => {
    hide(true);
    onSelect(option.value);
  };

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      show(event.key === 'ArrowUp' ? options.length - 1 : checkedIndex);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = options.length;
    const moves: Record<string, number> = {
      ArrowDown: (active + 1) % count,
      ArrowUp: (active - 1 + count) % count,
      Home: 0,
      End: count - 1,
    };
    const next = moves[event.key];
    if (next !== undefined) {
      event.preventDefault();
      setActive(next);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hide(true);
    } else if (event.key === 'Tab') {
      // Back on the button, the Tab then moves on from there.
      hide(true);
    } else if (event.key.length === 1 && /\S/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Type-ahead: the next item starting with that letter.
      const letter = event.key.toLowerCase();
      for (let step = 1; step <= count; step++) {
        const index = (active + step) % count;
        if (options[index]?.label.toLowerCase().startsWith(letter)) {
          setActive(index);
          break;
        }
      }
    }
  };

  return (
    <span className="wm-menu">
      <button
        ref={buttonRef}
        type="button"
        className={cx('wm-menu__button', className)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => (open ? hide(false) : show(checkedIndex))}
        onKeyDown={onButtonKeyDown}
        {...data}
      >
        {children}
        <IconChevronDown size={12} className="wm-menu__chevron" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={menuLabel ?? label}
          className="wm-menu__list"
          style={position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: 'hidden' }}
          onKeyDown={onMenuKeyDown}
          onBlur={(event) => {
            // Focus moved on to something else (a shortcut, say). A click that
            // doesn't focus (Safari, Firefox on macOS) has no relatedTarget.
            const next = event.relatedTarget;
            if (next instanceof Node && !menuRef.current?.contains(next) && !buttonRef.current?.contains(next)) hide(false);
          }}
        >
          {options.map((option, index) => {
            const checked = radio && option.value === value;
            return (
              <button
                key={option.value}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role={radio ? 'menuitemradio' : 'menuitem'}
                aria-checked={radio ? checked : undefined}
                tabIndex={-1}
                className="wm-menu__item"
                onClick={() => choose(option)}
                onMouseEnter={() => setActive(index)}
              >
                {option.icon ? (
                  <span className="wm-menu__icon" aria-hidden="true">
                    {option.icon}
                  </span>
                ) : null}
                <span className="wm-menu__label">{option.label}</span>
                {checked ? <IconCheck size={14} className="wm-menu__check" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}
