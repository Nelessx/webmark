import type { ReactNode } from 'react';
import { cx } from './cx';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label (clicking it toggles too). Also the accessible name. */
  label: ReactNode;
  /** Keep the label for screen readers only. */
  hideLabel?: boolean;
  /** Put the label before the track instead of after it. */
  labelFirst?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
}

export function Switch({ checked, onChange, label, hideLabel, labelFirst, disabled, title, className }: SwitchProps) {
  const text = <span className={hideLabel ? 'wm-visually-hidden' : 'wm-switch__label'}>{label}</span>;
  return (
    // A <button> is labelable, so clicking the label text toggles the switch.
    <label className={cx('wm-switch', disabled && 'is-disabled', className)} title={title}>
      {labelFirst ? text : null}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className="wm-switch__track"
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="wm-switch__thumb" />
      </button>
      {labelFirst ? null : text}
    </label>
  );
}
