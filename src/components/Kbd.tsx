import { cx } from './cx';
import { shortcutKeys } from './platform';

export interface KbdProps {
  /** A shortcut such as "Alt+Shift+M" (from browser.commands). Renders nothing if empty. */
  shortcut: string;
  /** Hide from screen readers (e.g. when the button already has aria-keyshortcuts). */
  decorative?: boolean;
  className?: string;
}

/** Keyboard shortcut as key caps; uses ⌥ ⇧ ⌘ glyphs on macOS. */
export function Kbd({ shortcut, decorative, className }: KbdProps) {
  const keys = shortcutKeys(shortcut);
  if (!keys.length) return null;
  return (
    <span className={cx('wm-kbd-group', className)} aria-hidden={decorative || undefined}>
      {decorative ? null : <span className="wm-visually-hidden">{shortcut}</span>}
      {keys.map((key, i) => (
        <kbd key={i} className="wm-kbd" aria-hidden="true">
          {key}
        </kbd>
      ))}
    </span>
  );
}
