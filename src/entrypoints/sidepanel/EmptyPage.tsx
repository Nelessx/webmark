import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { IconPin, IconPlus } from '@/components/icons';
import { Kbd } from '@/components/Kbd';

interface EmptyPageProps {
  /** Current "start-picker" shortcut ('' if unbound). */
  shortcut: string;
  onAdd: () => void;
}

/** First-run guidance when the current page has no notes. */
export function EmptyPage({ shortcut, onAdd }: EmptyPageProps) {
  return (
    <div className="sp-body">
      <EmptyState
        icon={<IconPin size={20} />}
        title="No notes on this page yet"
        description={
          <>
            <p>Attach feedback to any element on this page: a card, a button, a line of text.</p>
            <ul className="sp-howto">
              {shortcut ? (
                <li>
                  Press <Kbd shortcut={shortcut} />
                </li>
              ) : null}
              <li>
                Click <strong>Add note</strong>
              </li>
              <li>
                Right-click an element and choose <strong>Add WebMark note to this element</strong>
              </li>
            </ul>
          </>
        }
      >
        <Button variant="primary" icon={<IconPlus size={14} />} onClick={onAdd}>
          Add note
        </Button>
      </EmptyState>
    </div>
  );
}
