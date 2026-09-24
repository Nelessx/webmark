import { useId } from 'react';
import { cx } from './cx';

export interface LogoProps {
  /** Rendered size in px. */
  size?: number;
  /** Accessible name; decorative when omitted. */
  title?: string;
  className?: string;
}

/**
 * The WebMark mark: violet rounded square with a white bookmark ribbon. Same
 * geometry as scripts/generate-icons.mjs (128 grid); the yellow "note" dot is
 * dropped at small sizes, as in the 16/32 px toolbar icons.
 */
export function Logo({ size = 20, title, className }: LogoProps) {
  const gradientId = `wm-logo-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const showAccent = size >= 32;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 128 128"
      className={cx('wm-logo', className)}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="128" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6a5cff" />
          <stop offset="1" stopColor="#4b3ce0" />
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="28" fill={`url(#${gradientId})`} />
      <path d="M40 28.5a4.5 4.5 0 0 1 4.5-4.5h39a4.5 4.5 0 0 1 4.5 4.5V104L64 83.5 40 104Z" fill="#ffffff" />
      {showAccent ? (
        <>
          <circle cx="87.4" cy="24.6" r="16" fill={`url(#${gradientId})`} />
          <circle cx="87.4" cy="24.6" r="11.5" fill="#ffc857" />
        </>
      ) : null}
    </svg>
  );
}
