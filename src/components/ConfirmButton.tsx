import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ButtonSize, ButtonVariant } from './Button';
import { cx } from './cx';

export interface ConfirmButtonProps {
  /** Idle text (the accessible name in icon-only mode). */
  label: string;
  /** Text while armed. */
  confirmLabel?: string;
  icon?: ReactNode;
  /** Idle state shows only the icon (styled like IconButton); armed state shows confirmLabel. */
  iconOnly?: boolean;
  onConfirm: () => void;
  /** Idle look; the armed state is always "danger". */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** How long the armed state lasts. */
  timeoutMs?: number;
  disabled?: boolean;
  className?: string;
}

/**
 * Two-step destructive action: the first click arms it ("Confirm?") for a few
 * seconds, the second click runs onConfirm. Blur or timeout disarms. It stays
 * the same <button> element so keyboard focus is kept between clicks.
 */
export function ConfirmButton({
  label,
  confirmLabel = 'Confirm?',
  icon,
  iconOnly,
  onConfirm,
  variant = 'ghost',
  size = 'md',
  timeoutMs = 3000,
  disabled,
  className,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const disarm = () => {
    clearTimeout(timer.current);
    setArmed(false);
  };

  const onClick = () => {
    if (armed) {
      disarm();
      onConfirm();
      return;
    }
    setArmed(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setArmed(false), timeoutMs);
  };

  const compactIdle = iconOnly && !armed;
  const classes = compactIdle
    ? cx('wm-icon-btn', `wm-icon-btn--${variant === 'danger' ? 'danger' : 'ghost'}`, `wm-icon-btn--${size}`, 'wm-confirm', className)
    : cx('wm-btn', `wm-btn--${armed ? 'danger' : variant}`, `wm-btn--${size}`, 'wm-confirm', armed && 'is-armed', className);

  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      onBlur={armed ? disarm : undefined}
      disabled={disabled}
      aria-label={compactIdle ? label : undefined}
      title={compactIdle ? label : undefined}
    >
      {icon ? <span className="wm-btn__icon">{icon}</span> : null}
      {compactIdle ? null : (
        <span className="wm-btn__label" aria-live="polite">
          {armed ? confirmLabel : label}
        </span>
      )}
    </button>
  );
}
