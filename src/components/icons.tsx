import type { ReactNode, SVGProps } from 'react';

/*
 * Inline SVG icon set: 24×24 grid drawn at 16px by default, 1.75 stroke,
 * currentColor. Decorative unless `title` is given (then role="img").
 */

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
  title?: string;
}

function createIcon(name: string, content: ReactNode) {
  function Icon({ size = 16, title, className, ...rest }: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className ? `wm-icon ${className}` : 'wm-icon'}
        focusable="false"
        aria-hidden={title ? undefined : true}
        role={title ? 'img' : undefined}
        {...rest}
      >
        {title ? <title>{title}</title> : null}
        {content}
      </svg>
    );
  }
  Icon.displayName = `Icon${name}`;
  return Icon;
}

export const IconPlus = createIcon('Plus', <path d="M12 5v14M5 12h14" />);

export const IconCrosshair = createIcon(
  'Crosshair',
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M21 12h-4M7 12H3M12 7V3M12 21v-4" />
  </>,
);

export const IconPin = createIcon(
  'Pin',
  <>
    <path d="M19 10c0 5-7 11.5-7 11.5S5 15 5 10a7 7 0 0 1 14 0Z" />
    <circle cx="12" cy="10" r="2.5" />
  </>,
);

export const IconEye = createIcon(
  'Eye',
  <>
    <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);

export const IconEyeOff = createIcon(
  'EyeOff',
  <>
    <path d="M3 3l18 18" />
    <path d="M10.6 5.1A9.7 9.7 0 0 1 12 5c6 0 9.5 7 9.5 7a16.4 16.4 0 0 1-2.7 3.6" />
    <path d="M6.6 6.6C4 8.3 2.5 12 2.5 12S6 19 12 19c1.8 0 3.4-.6 4.8-1.4" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </>,
);

export const IconSearch = createIcon(
  'Search',
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.9-3.9" />
  </>,
);

export const IconTrash = createIcon(
  'Trash',
  <>
    <path d="M3.5 6h17" />
    <path d="M8.5 6V4.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5V6" />
    <path d="m18.5 6-.8 13.1a2 2 0 0 1-2 1.9H8.3a2 2 0 0 1-2-1.9L5.5 6" />
    <path d="M10 10.5v6M14 10.5v6" />
  </>,
);

export const IconPencil = createIcon(
  'Pencil',
  <>
    <path d="M16.9 3.6a2.2 2.2 0 0 1 3.1 3.1L7.6 19.1 3 21l1.9-4.6Z" />
    <path d="m14.5 6 3.5 3.5" />
  </>,
);

export const IconCheck = createIcon('Check', <path d="M20 6 9 17l-5-5" />);

export const IconRotateCcw = createIcon(
  'RotateCcw',
  <>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5" />
    <path d="M3.5 3.5v5h5" />
  </>,
);

export const IconCopy = createIcon(
  'Copy',
  <>
    <rect x="8" y="8" width="13" height="13" rx="2" />
    <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
  </>,
);

export const IconExternalLink = createIcon(
  'ExternalLink',
  <>
    <path d="M14 3h7v7" />
    <path d="M10 14 21 3" />
    <path d="M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
  </>,
);

export const IconPanelRight = createIcon(
  'PanelRight',
  <>
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
    <path d="M15 3v18" />
  </>,
);

export const IconLayoutGrid = createIcon(
  'LayoutGrid',
  <>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
  </>,
);

export const IconX = createIcon('X', <path d="M18 6 6 18M6 6l12 12" />);

export const IconImage = createIcon(
  'Image',
  <>
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.6-3.6a2 2 0 0 0-2.8 0L5 21" />
  </>,
);

export const IconTag = createIcon(
  'Tag',
  <>
    <path d="M12.6 2.6a2 2 0 0 0-1.4-.6H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4Z" />
    <circle cx="7.5" cy="7.5" r="1.25" fill="currentColor" stroke="none" />
  </>,
);

export const IconDownload = createIcon(
  'Download',
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
    <path d="M12 15V3" />
  </>,
);

export const IconUpload = createIcon(
  'Upload',
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m17 8-5-5-5 5" />
    <path d="M12 3v12" />
  </>,
);

export const IconSettings = createIcon(
  'Settings',
  <>
    <path d="M10.08 4.85 10.33 2.55A9.6 9.6 0 0 1 13.67 2.55L13.92 4.85A7.4 7.4 0 0 1 15.7 5.59L17.51 4.14A9.6 9.6 0 0 1 19.86 6.49L18.41 8.3A7.4 7.4 0 0 1 19.15 10.08L21.45 10.33A9.6 9.6 0 0 1 21.45 13.67L19.15 13.92A7.4 7.4 0 0 1 18.41 15.7L19.86 17.51A9.6 9.6 0 0 1 17.51 19.86L15.7 18.41A7.4 7.4 0 0 1 13.92 19.15L13.67 21.45A9.6 9.6 0 0 1 10.33 21.45L10.08 19.15A7.4 7.4 0 0 1 8.3 18.41L6.49 19.86A9.6 9.6 0 0 1 4.14 17.51L5.59 15.7A7.4 7.4 0 0 1 4.85 13.92L2.55 13.67A9.6 9.6 0 0 1 2.55 10.33L4.85 10.08A7.4 7.4 0 0 1 5.59 8.3L4.14 6.49A9.6 9.6 0 0 1 6.49 4.14L8.3 5.59A7.4 7.4 0 0 1 10.08 4.85Z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);

export const IconAlertTriangle = createIcon(
  'AlertTriangle',
  <>
    <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </>,
);

export const IconMoreHorizontal = createIcon(
  'MoreHorizontal',
  <>
    <circle cx="5" cy="12" r="1.25" fill="currentColor" />
    <circle cx="12" cy="12" r="1.25" fill="currentColor" />
    <circle cx="19" cy="12" r="1.25" fill="currentColor" />
  </>,
);

export const IconChevronDown = createIcon('ChevronDown', <path d="m6 9 6 6 6-6" />);

export const IconKeyboard = createIcon(
  'Keyboard',
  <>
    <rect x="2" y="5" width="20" height="14" rx="2.5" />
    <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12.5h.01M18 12.5h.01M10 12.5h4M7.5 16h9" />
  </>,
);
