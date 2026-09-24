/** Bump when the stored Note shape changes, and add a migration in storage.ts. */
export const NOTE_SCHEMA_VERSION = 1;

export type NoteStatus = 'open' | 'resolved';

/** A rectangle in document coordinates (viewport rect + scroll offset at capture time). */
export interface DocRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Everything we remember about an element so we can find it again later.
 * Several independent strategies are stored because any single one can break
 * when the page changes (redeploys, hashed class names, reordered lists...).
 */
export interface ElementAnchor {
  /** Unique CSS selector at capture time, built from stable attributes where possible. */
  selector: string;
  /** Absolute XPath at capture time, e.g. /html/body/div[2]/main/section[1]/div[3]. */
  xpath: string;
  /** Lower-case tag name. */
  tagName: string;
  /** Element id, only if it looked stable (not auto-generated). */
  id?: string;
  /** Class names that looked stable (hashed / utility classes filtered out). */
  classes: string[];
  /** Stable identifying attributes: data-testid, aria-label, role, name, href, etc. */
  attributes: Record<string, string>;
  /** Whitespace-collapsed text content, truncated to 300 chars. */
  text: string;
  /** Position and size in document coordinates at capture time. */
  rect: DocRect;
  /** Viewport size at capture time; used to normalise rect distances. */
  viewport: { width: number; height: number };
  /** Lower-case tag names of ancestors, nearest first, excluding <html>, max 12. */
  ancestorTags: string[];
  /** 1-based index among siblings with the same tag (like :nth-of-type). */
  nthOfType: number;
}

export interface Note {
  id: string;
  schemaVersion: number;
  /** Normalised page identity, see getPageKey() in url.ts. */
  pageKey: string;
  /** Full URL at the time the note was created. */
  url: string;
  pageTitle: string;
  /** Human-readable breadcrumb for the element, e.g. "Dashboard → Revenue Card". */
  label: string;
  body: string;
  status: NoteStatus;
  tags: string[];
  /** Who wrote the note (from settings.authorName). Empty string if unset. */
  author: string;
  anchor: ElementAnchor;
  /** True when a cropped screenshot is stored under the note id. */
  hasScreenshot: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Fields a caller may change on an existing note. */
export type NotePatch = Partial<Pick<Note, 'label' | 'body' | 'status' | 'tags' | 'anchor' | 'hasScreenshot'>>;

export interface Settings {
  /** Show numbered pins on annotated elements when a page loads. */
  pinsVisible: boolean;
  /** Save a cropped screenshot of the element with each new note. */
  captureScreenshots: boolean;
  /** Stamped on new notes so exported feedback shows who wrote it. */
  authorName: string;
}

export const DEFAULT_SETTINGS: Settings = {
  pinsVisible: true,
  captureScreenshots: true,
  authorName: '',
};
