import { outsideModal } from '../store';
import { useAppState, useBox } from './context';

export type OutlineVariant = 'target' | 'hover' | 'flash';

const PAD = 3;

/** A box drawn over a page element. The page element itself is never styled. */
export function Outline({ element, variant }: { element: Element; variant: OutlineVariant }) {
  const box = useBox(element);
  const modal = useAppState((s) => s.modal);
  if (!box?.visible || outsideModal(modal, element)) return null;
  return (
    <div
      className={`wm-outline wm-outline--${variant}`}
      data-wm-outline={variant}
      aria-hidden="true"
      style={{
        translate: `${box.left - PAD}px ${box.top - PAD}px`,
        width: box.width + PAD * 2,
        height: box.height + PAD * 2,
      }}
    />
  );
}
