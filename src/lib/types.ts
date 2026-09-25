/**
 * Bump when the stored Note shape changes, and add a migration in storage.ts.
 * 2: four statuses (the old 'resolved' is 'completed') and a priority.
 */
export const NOTE_SCHEMA_VERSION = 2;

/**
 * Workflow of a note. 'archived' notes are put away: no pin on the page and
 * left out of the default lists. Labels and helpers live in noteMeta.ts.
 */
export type NoteStatus = 'open' | 'in_progress' | 'completed' | 'archived';

export type NotePriority = 'low' | 'medium' | 'high';

/** A rectangle in document coordinates (viewport rect + scroll offset at capture time). */
export interface DocRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The card, row or list item around an element, recorded when other elements
 * look the same (repeated "Edit" / "Add to cart" buttons): the item's content
 * is what tells them apart.
 */
export interface AnchorItem {
  /** Levels from the element up to the item (1 = parent). */
  depth: number;
  /** Lower-cased, whitespace-collapsed text of the item, cut at a word boundary (max 120 characters). */
  text: string;
  /** Length of the item's whole normalised text (capped at 2000), to tell it from a bigger container that starts the same way. */
  length: number;
  /** No look-alike's item had the same text shape (digits masked): the item's numbers may change without it becoming another item. */
  shapeUnique: boolean;
  /** A test attribute of the item that matched only the item at capture time. */
  testId?: { name: string; value: string };
}

/**
 * Everything we remember about an element so we can find it again later.
 * Several independent strategies are stored because any single one can break
 * when the page changes (redeploys, hashed class names, reordered lists...).
 *
 * Optional fields were added later; anchors stored before them lack them and
 * are resolved with conservative fallback rules.
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
  /** How many other elements had the same tag, identifying attributes and text at capture time (0 = unique). */
  lookAlikes?: number;
  /**
   * False when same-kind elements differed from this one only in their numbers
   * ("Order #1001" / "Order #1002"): then the numbers are part of its identity.
   */
  shapeUnique?: boolean;
  /** Which hooks ('id', test attributes) matched only this element at capture time. */
  uniqueHooks?: string[];
  /** The item that tells this element apart from its look-alikes, when there were any. */
  item?: AnchorItem;
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
  /**
   * While archived: the status the note had before, so unarchiving puts it
   * back (storage keeps this in step with the status). Absent otherwise, and
   * on notes archived before it was kept, which unarchive to open.
   */
  archivedFrom?: Exclude<NoteStatus, 'archived'>;
  priority: NotePriority;
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
export type NotePatch = Partial<
  Pick<Note, 'label' | 'body' | 'status' | 'priority' | 'tags' | 'anchor' | 'hasScreenshot'>
>;

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
