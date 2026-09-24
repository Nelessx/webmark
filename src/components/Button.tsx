import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon, e.g. <IconPlus />. */
  icon?: ReactNode;
  /** Trailing content pushed to the end, e.g. a <Kbd /> shortcut. */
  trailing?: ReactNode;
  /** Stretch to the container width. */
  block?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  trailing,
  block,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('wm-btn', `wm-btn--${variant}`, `wm-btn--${size}`, block && 'wm-btn--block', className)}
      {...rest}
    >
      {icon ? <span className="wm-btn__icon">{icon}</span> : null}
      {children !== undefined && children !== null ? <span className="wm-btn__label">{children}</span> : null}
      {trailing ? <span className="wm-btn__trailing">{trailing}</span> : null}
    </button>
  );
}

export type IconButtonVariant = 'ghost' | 'secondary' | 'danger';

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'aria-pressed'> {
  /** Accessible name; also shown as the tooltip. */
  label: string;
  icon: ReactNode;
  variant?: IconButtonVariant;
  size?: ButtonSize;
  /** Set for toggle buttons: renders aria-pressed and the active style. */
  pressed?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  label,
  icon,
  variant = 'ghost',
  size = 'md',
  pressed,
  className,
  title,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx('wm-icon-btn', `wm-icon-btn--${variant}`, `wm-icon-btn--${size}`, className)}
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      {...rest}
    >
      {icon}
    </button>
  );
}
