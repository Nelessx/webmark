/*
 * Longest values WebMark accepts in a note. Imported files are refused beyond
 * these, and the dashboard editor stops typing there. Each is well above what
 * WebMark itself produces (noted per field), so any note it created, exported
 * and imported again fits.
 */
export const NOTE_LIMITS = {
  /** Note ids: crypto.randomUUID(), 36 characters. */
  id: 200,
  /** Page URLs: typically far below this, though browsers allow more. */
  url: 16_384,
  pageTitle: 2_000,
  /** User text. Generated labels are at most ~85 characters. */
  label: 1_000,
  /** User text. */
  body: 100_000,
  /** Settings allow 60 characters. */
  author: 200,
  /** parseTags() keeps 10 tags of 32 characters. */
  tags: 50,
  tag: 100,
  /** Anchor selector / XPath: grows with DOM depth; unbounded ones would run on every resolve. */
  selector: 4_000,
  xpath: 4_000,
  tagName: 100,
  /** Stable ids are at most 64 characters. */
  elementId: 200,
  /** Up to 20 stable classes of at most 50 characters. */
  classes: 50,
  className: 200,
  /** About 15 identifying attributes, values cut to 200 characters. */
  attributes: 50,
  attributeName: 100,
  attributeValue: 1_000,
  /** Anchor text is cut to 300 characters. */
  text: 1_000,
  /** At most 12 ancestors. */
  ancestors: 50,
} as const;
