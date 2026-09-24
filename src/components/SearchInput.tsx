import type { KeyboardEvent, Ref } from 'react';
import { cx } from './cx';
import { IconSearch, IconX } from './icons';

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Accessible name. Defaults to the placeholder, then "Search". */
  label?: string;
  /** Key hint shown while empty, e.g. "/". */
  hint?: string;
  autoFocus?: boolean;
  className?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  ref?: Ref<HTMLInputElement>;
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  label,
  hint,
  autoFocus,
  className,
  onKeyDown,
  ref,
}: SearchInputProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === 'Escape' && value) {
      // Clear first; a second Escape can bubble (e.g. to close a dialog).
      event.preventDefault();
      event.stopPropagation();
      onChange('');
    }
  };

  return (
    <div className={cx('wm-search', className)}>
      <IconSearch className="wm-search__icon" />
      <input
        ref={ref}
        type="search"
        className="wm-input wm-search__input"
        value={value}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {value ? (
        <button type="button" className="wm-search__clear" aria-label="Clear search" title="Clear" onClick={() => onChange('')}>
          <IconX size={14} />
        </button>
      ) : hint ? (
        <kbd className="wm-kbd wm-search__hint" aria-hidden="true">
          {hint}
        </kbd>
      ) : null}
    </div>
  );
}
