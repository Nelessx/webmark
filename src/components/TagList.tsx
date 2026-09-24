import { cx } from './cx';

export interface TagListProps {
  tags: readonly string[];
  /** Makes each tag a toggle button (e.g. filters). */
  onTagClick?: (tag: string) => void;
  /** Tags shown as selected (aria-pressed). Only used with onTagClick. */
  activeTags?: readonly string[];
  /** Optional count per tag, shown after the name. */
  counts?: Readonly<Record<string, number>>;
  /** Accessible name of the list, e.g. "Filter by tag". */
  label?: string;
  className?: string;
}

export function TagList({ tags, onTagClick, activeTags, counts, label, className }: TagListProps) {
  if (!tags.length) return null;
  return (
    <ul className={cx('wm-tags', className)} aria-label={label}>
      {tags.map((tag) => {
        const count = counts?.[tag];
        const content = (
          <>
            <span className="wm-tag__hash" aria-hidden="true">
              #
            </span>
            <span className="wm-tag__name">{tag}</span>
            {count !== undefined ? <span className="wm-tag__count">{count}</span> : null}
          </>
        );
        return (
          <li key={tag}>
            {onTagClick ? (
              <button
                type="button"
                className="wm-tag"
                aria-pressed={activeTags?.includes(tag) ?? false}
                onClick={() => onTagClick(tag)}
              >
                {content}
              </button>
            ) : (
              <span className="wm-tag">{content}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
