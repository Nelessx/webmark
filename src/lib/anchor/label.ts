import { WEBMARK_HOST_TAG } from '../constants';
import {
  POSITION_FOLLOWING,
  collapseWhitespace,
  composedParent,
  cssEscape,
  isEditingHost,
  isFormControl,
  isInsideEditable,
  queryRoot,
  tagOf,
  truncate,
} from './dom';
import { rankClasses, stableClasses, stableIdOf } from './stability';
import { firstTextFragment, readText } from './text';

const SEPARATOR = ' → ';
const MAX_PART = 40;
const MAX_DESCRIPTION = 48;
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
/** Title separators: "Dashboard | Acme", "Pricing — Acme", "Docs · Acme", "Home - Acme". */
const TITLE_SEPARATOR = /\s+[-|–—·]\s+|[|–—·]/;

interface Kind {
  /** Appended to the name ("Save" → "Save button"); empty when it adds nothing. */
  word: string;
  /** Used alone when the element has no name at all. */
  fallback: string;
}

const FALLBACK_NAMES: Record<string, string> = {
  section: 'Section',
  article: 'Article',
  header: 'Header',
  footer: 'Footer',
  main: 'Main content',
  aside: 'Sidebar',
  nav: 'Navigation',
  p: 'Paragraph',
  li: 'List item',
  td: 'Table cell',
  th: 'Table cell',
  tr: 'Table row',
  span: 'Text',
  label: 'Label',
  form: 'Form',
};

const LANDMARKS: Record<string, string> = {
  header: 'Header',
  banner: 'Header',
  footer: 'Footer',
  contentinfo: 'Footer',
  nav: 'Navigation',
  navigation: 'Navigation',
  aside: 'Sidebar',
  complementary: 'Sidebar',
  dialog: 'Dialog',
  alertdialog: 'Dialog',
};

/** Human-readable breadcrumb, e.g. "Dashboard → Revenue card". Never empty. */
export function buildLabel(el: Element): string {
  const name = elementName(el) || 'Element';
  const section = sectionName(el);
  // Skip a section the name already mentions ("Pro plan → Pro plan card").
  if (!section || name.toLowerCase().includes(section.toLowerCase())) return truncate(name, MAX_PART);
  return `${truncate(section, MAX_PART)}${SEPARATOR}${truncate(name, MAX_PART)}`;
}

/** Short technical description for the picker tooltip, e.g. "button#save.btn-primary". */
export function describeElement(el: Element): string {
  let out = tagOf(el);
  const id = stableIdOf(el);
  if (id) out += `#${id}`;
  for (const name of rankClasses(stableClasses(el)).slice(0, 2)) out += `.${name}`;
  return truncate(out, MAX_DESCRIPTION);
}

// ---------------------------------------------------------------------------
// Element name

function elementName(el: Element): string {
  const kind = kindOf(el);
  const name = accessibleName(el);
  if (!name) return kind?.fallback ?? FALLBACK_NAMES[tagOf(el)] ?? 'Element';
  if (!kind?.word || containsWord(name, kind.word)) return truncate(name, MAX_PART);
  return `${truncate(name, MAX_PART - kind.word.length - 1)} ${kind.word}`;
}

function attr(el: Element, name: string): string {
  return collapseWhitespace(el.getAttribute(name) ?? '');
}

/**
 * Text typed by the user (contenteditable regions, custom text boxes) is never
 * stored, same as the anchor text: labels fall back to authored attributes.
 */
function isTypedText(el: Element): boolean {
  return isInsideEditable(el) || /^(?:textbox|searchbox)$/i.test(el.getAttribute('role') ?? '');
}

function labelText(el: Element): string {
  return isTypedText(el) ? '' : readText(el, 80, ' ');
}

function accessibleName(el: Element): string {
  const control = isFormControl(el);
  const typed = !control && isTypedText(el);
  return (
    attr(el, 'aria-label') ||
    labelledByText(el) ||
    attr(el, 'alt') ||
    (control ? fieldLabel(el) : '') ||
    attr(el, 'title') ||
    (control ? buttonInputText(el) : typed ? '' : headingInside(el) || svgTitle(el) || shortText(el)) ||
    attr(el, 'placeholder') ||
    attr(el, 'name') ||
    imageFileName(el)
  );
}

function labelledByText(el: Element): string {
  const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  if (!ids.length) return '';
  const root = queryRoot(el);
  const parts = ids.map((id) => {
    const ref = root.getElementById(id);
    return ref ? labelText(ref) : '';
  });
  return collapseWhitespace(parts.join(' '));
}

/** <label for="id"> or a wrapping <label>. */
function fieldLabel(el: Element): string {
  const id = el.getAttribute('id');
  if (id) {
    const label = queryRoot(el).querySelector(`label[for="${cssEscape(id)}"]`);
    if (label) return labelText(label);
  }
  const wrapping = el.closest('label');
  return wrapping ? labelText(wrapping) : '';
}

/** The caption of <input type="submit" value="Sign up"> is page-authored, never typed by the user. */
function buttonInputText(el: Element): string {
  if (tagOf(el) !== 'input') return '';
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  return type === 'submit' || type === 'button' || type === 'reset' ? attr(el, 'value') : '';
}

function headingInside(el: Element): string {
  const heading = el.querySelector(HEADING_SELECTOR);
  return heading ? labelText(heading) : '';
}

function svgTitle(el: Element): string {
  if (tagOf(el) !== 'svg') return '';
  const title = el.querySelector('title');
  return title ? labelText(title) : '';
}

/** Own text when short; otherwise its first text fragment ("first line"). */
function shortText(el: Element): string {
  const text = readText(el, 120, ' ');
  if (!text || text.length <= MAX_PART) return text;
  return truncate(firstTextFragment(el) || text, MAX_PART);
}

/** "logo.svg" → "logo": a readable file name is better than nothing for an unlabelled image. */
function imageFileName(el: Element): string {
  if (tagOf(el) !== 'img') return '';
  const src = el.getAttribute('src') ?? '';
  if (/^(?:data|blob):/i.test(src)) return '';
  const file = src.split(/[?#]/)[0]?.split('/').pop() ?? '';
  const base = file.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
  return /^[a-z][a-z ]{1,29}$/i.test(base) ? base : '';
}

function kindOf(el: Element): Kind | null {
  const tag = tagOf(el);
  const role = (el.getAttribute('role') ?? '').toLowerCase();
  const type = (el.getAttribute('type') ?? '').toLowerCase();

  if (tag === 'button' || role === 'button' || (tag === 'input' && /^(?:button|submit|reset)$/.test(type))) {
    return { word: 'button', fallback: 'Button' };
  }
  if ((tag === 'a' && el.hasAttribute('href')) || role === 'link') return { word: 'link', fallback: 'Link' };
  if (tag === 'img' || tag === 'svg' || tag === 'picture' || role === 'img' || (tag === 'input' && type === 'image')) {
    return { word: 'image', fallback: 'Image' };
  }
  if (tag === 'input') {
    if (type === 'checkbox') return { word: 'checkbox', fallback: 'Checkbox' };
    if (type === 'radio') return { word: 'option', fallback: 'Option' };
    if (type === 'range') return { word: 'slider', fallback: 'Slider' };
    if (type === 'file') return { word: 'upload', fallback: 'File upload' };
    return { word: 'field', fallback: 'Field' };
  }
  if (tag === 'textarea' || role === 'textbox' || role === 'searchbox' || isEditingHost(el)) {
    return { word: 'field', fallback: 'Field' };
  }
  if (tag === 'select' || role === 'combobox' || role === 'listbox') return { word: 'dropdown', fallback: 'Dropdown' };
  if (/^h[1-6]$/.test(tag) || role === 'heading') return { word: '', fallback: 'Heading' };
  if (tag === 'table' || role === 'table' || role === 'grid') return { word: 'table', fallback: 'Table' };
  if (tag === 'form') return { word: 'form', fallback: 'Form' };
  if (tag === 'ul' || tag === 'ol' || role === 'list') return { word: 'list', fallback: 'List' };
  if (tag === 'video') return { word: 'video', fallback: 'Video' };
  if (tag === 'iframe') return { word: 'frame', fallback: 'Embedded frame' };
  if (tag === 'dialog' || role === 'dialog') return { word: 'dialog', fallback: 'Dialog' };
  if (looksLikeCard(el)) return { word: 'card', fallback: 'Card' };
  return null;
}

function looksLikeCard(el: Element): boolean {
  const classes = el.getAttribute('class') ?? '';
  return classes.split(/\s+/).some((name) => /(?:^|[-_])card$/i.test(name) || /[a-z]Card$/.test(name));
}

function containsWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'i').test(text);
}

// ---------------------------------------------------------------------------
// Section

function sectionName(el: Element): string {
  for (let current = composedParent(el); current; current = composedParent(current)) {
    const tag = tagOf(current);
    if (tag === 'html' || tag === WEBMARK_HOST_TAG) break;
    if (tag !== 'body') {
      const named = attr(current, 'aria-label') || labelledByText(current);
      if (named) return named;
    }
    const heading = precedingHeading(current, el);
    if (heading) return heading;
    const landmark = LANDMARKS[(current.getAttribute('role') ?? '').toLowerCase()] ?? LANDMARKS[tag];
    if (landmark) return landmark;
    if (tag === 'body') break;
  }
  return titleSegment(el.ownerDocument.title);
}

/**
 * The nearest heading before `el` that belongs to `container` itself — not one
 * buried in a sibling card, which would label the wrong thing.
 */
function precedingHeading(container: Element, el: Element): string {
  const headings = container.querySelectorAll(HEADING_SELECTOR);
  for (let i = headings.length - 1; i >= 0; i--) {
    const heading = headings[i];
    if (!heading || heading === el || el.contains(heading) || heading.contains(el)) continue;
    if (!(heading.compareDocumentPosition(el) & POSITION_FOLLOWING)) continue;
    if (!isOwnHeading(container, heading)) continue;
    const text = labelText(heading);
    if (text) return text;
  }
  return '';
}

function isOwnHeading(container: Element, heading: Element): boolean {
  let depth = 0;
  for (let current = heading.parentElement; current && current !== container; current = current.parentElement) {
    if (++depth > 2 || isRepeatingItem(current)) return false;
  }
  return true;
}

function isRepeatingItem(el: Element): boolean {
  const tag = tagOf(el);
  if (tag === 'li' || tag === 'article' || tag === 'tr') return true;
  return /(?:^|[\s_-])(?:card|item|tile)(?:$|[\s_-])|[a-z](?:Card|Item|Tile)\b/.test(el.getAttribute('class') ?? '');
}

function titleSegment(title: string): string {
  return collapseWhitespace(title.split(TITLE_SEPARATOR)[0] ?? '');
}
