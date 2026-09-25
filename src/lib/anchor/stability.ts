/**
 * Heuristics that decide whether an id or class name will survive a reload or
 * redeploy. Anything generated (framework counters, CSS-in-JS hashes) or
 * state-dependent (active, open...) is rejected: a selector built on it would
 * silently point somewhere else next time.
 */

/** Attributes that exist purely as automation hooks; treated as strong identity. */
export const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa'] as const;

const MAX_ID_LENGTH = 64;
const MAX_CLASS_LENGTH = 50;
const MAX_STABLE_CLASSES = 20;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** React 19.2 useId ("_r_1_"); older forms (":r1:", "«r1»") are caught by the character check. */
const REACT_ID = /^_r_[0-9a-z]+_$/i;
/** Prefixes that are always machine-generated. */
const GENERATED_PREFIX = /^(?:radix-|headlessui-|react-aria|__bvid__|yui_|ext-gen|gwt-uid|j_idt|pr_id_|floating-ui-)/i;
/** Component libraries that number their instances: "mui-123", "mat-input-0", "ember42". */
const LIBRARY_COUNTER =
  /^(?:ember|mui|mat|cdk|rc|tippy|ui-id|el-id|select2|chakra|mantine|downshift|react-select|vs)(?:[-_].*)?\d/i;
/** Generic words followed only by a counter: "input-5", "tab-2", "item12". */
const GENERIC_COUNTER =
  /^(?:input|field|label|menu|menuitem|list|listbox|option|tab|tabpanel|panel|dialog|modal|popup|popover|tooltip|dropdown|select|combobox|checkbox|radio|switch|slider|accordion|collapse|button|comp|id|el|elem|element|node|item|uid|gen|auto|anon|ext)[-_]?\d+$/i;

const STATE_CLASSES = new Set([
  'active', 'hover', 'hovered', 'focus', 'focused', 'focus-visible', 'focus-within', 'open', 'opened',
  'selected', 'disabled', 'checked', 'expanded', 'collapsed', 'visible', 'invisible', 'hidden', 'show',
  'shown', 'showing', 'in', 'current', 'highlighted', 'pressed', 'loading', 'loaded', 'dragging',
  'dragover', 'dirty', 'pristine', 'touched', 'untouched', 'valid', 'invalid', 'error', 'stuck',
  'scrolled', 'animating', 'entering', 'leaving', 'visited', 'playing', 'paused', 'on', 'off',
]);
/** BEM / framework state modifiers: "nav__item--active", "router-link-active", "tab_selected". */
const STATE_SUFFIX =
  /[-_](?:active|hover|hovered|focus|focused|open|opened|selected|disabled|checked|expanded|collapsed|current|visible|hidden|pressed|loading|loaded|dragging|invalid|valid|dirty|pristine|touched|highlighted)$/i;
/** "is-active", "has-error", "isOpen". */
const STATE_PREFIX = /^(?:is|has)(?:[-_]|[A-Z])/;

const GENERATED_CLASS: RegExp[] = [
  /^sc-/, // styled-components
  /^css-[a-z0-9]{5,}(?:-|$)/i, // emotion
  /^jsx-\d+$/, // styled-jsx
  /^(?:svelte|astro)-(?=[a-z]*\d)[a-z0-9]{4,}$/i, // scoped styles
  /^jss\d+$/, // JSS
  /^(?:makeStyles|withStyles|tss)-/,
  /^Mui-/, // MUI state classes: Mui-selected, Mui-focusVisible
  /^ng-/, // Angular: ng-touched, ng-star-inserted, ng-tns-c12-3
  /^_ng(?:content|host)-/,
  /^(?:emotion|glamor)-/,
  /^_[\w-]+_[a-z0-9]{5}_\d+$/i, // Vite CSS modules: _local_hash_line
  /^(?:wm-|webmark)/i, // our own UI
];
/** css-loader modules: "[name]_[local]__[hash]" e.g. "Button_primary__3xYz1". */
const CSS_MODULE = /^[A-Za-z][A-Za-z0-9-]*_[A-Za-z0-9-]+__([A-Za-z0-9_-]{5,})$/;

/** Utility-first classes: kept (they are stable) but ranked below semantic names. */
const UTILITY_CLASS =
  /^-?(?:[mp][trblxyse]?|w|h|min-[wh]|max-[wh]|size|gap|space-[xy]|inset|top|right|bottom|left|z|order|col|row|grid-cols|grid-rows|flex|basis|grow|shrink|text|font|leading|tracking|bg|from|via|to|border|rounded|shadow|opacity|ring|outline|fill|stroke|d|align|justify|items|self|place|overflow|whitespace|break|cursor|pointer-events|transition|duration|ease|delay|animate|transform|scale|rotate|translate|skew|origin|sr|float|clear|object|aspect|decoration|underline|truncate|uppercase|lowercase|capitalize|italic|static|fixed|absolute|relative|sticky|block|inline|inline-block|inline-flex|grid|table|mx|my|px|py|pt|pb|pl|pr|mt|mb|ml|mr|fs|fw|lh|g|gx|gy|offset|container)(?:-|$)/;

/**
 * Hash-like token: long hex, base64-ish, or letters and digits interleaved
 * ("l0yrd4ly"). `minSwitches` counts letter/digit alternations.
 */
export function looksRandomToken(token: string, minSwitches = 3): boolean {
  if (token.length >= 8 && /^[0-9a-f]+$/i.test(token) && /\d/.test(token) && /[a-f]/i.test(token)) return true;
  if (token.length >= 12 && /^[A-Za-z0-9+/=]+$/.test(token) && /\d/.test(token) && /[a-z]/.test(token) && /[A-Z]/.test(token)) {
    return true;
  }
  if (token.length < 5) return false;
  let switches = 0;
  let previousDigit: boolean | null = null;
  for (const char of token) {
    const digit = char >= '0' && char <= '9';
    if (previousDigit !== null && digit !== previousDigit) switches++;
    previousDigit = digit;
  }
  return switches >= minSwitches;
}

/** True for values that look machine-generated (uuids, hashes, React ids) — used for name/for values. */
export function looksGenerated(value: string): boolean {
  if (/[:«»]/.test(value) || REACT_ID.test(value) || UUID.test(value)) return true;
  return value.split(/[-_.:[\]]+/).some((token) => looksRandomToken(token));
}

/** Whether an element id is likely authored by a human and stable across reloads. */
export function isStableId(id: string): boolean {
  if (!id || id.length > MAX_ID_LENGTH || /\s/.test(id)) return false;
  // Any colon or guillemet: React useId (":r1:", "«r1»") and ids that embed it ("radix-:r2:-trigger").
  if (/[:«»]/.test(id) || REACT_ID.test(id)) return false;
  if (/^\d/.test(id)) return false;
  if (GENERATED_PREFIX.test(id) || LIBRARY_COUNTER.test(id) || GENERIC_COUNTER.test(id)) return false;
  if (UUID.test(id)) return false;
  if (/[a-z]/i.test(id) && /\d{3,}/.test(id)) return false;
  return !id.split(/[-_.]+/).some((token) => looksRandomToken(token));
}

export function stableIdOf(el: Element): string | undefined {
  const id = el.getAttribute('id');
  return id && isStableId(id) ? id : undefined;
}

const stableClassCache = new Map<string, boolean>();

/** Whether a class name is authored, stable and not a state toggle. Memoised: class names repeat a lot. */
export function isStableClass(className: string): boolean {
  const cached = stableClassCache.get(className);
  if (cached !== undefined) return cached;
  const result = computeStableClass(className);
  if (stableClassCache.size > 5000) stableClassCache.clear();
  stableClassCache.set(className, result);
  return result;
}

function computeStableClass(name: string): boolean {
  if (!name || name.length > MAX_CLASS_LENGTH) return false;
  // Tailwind variants and arbitrary values ("md:flex", "w-[32px]", "w-1/2", "!mt-0") and anything exotic.
  if (/[^A-Za-z0-9_-]/.test(name)) return false;
  if (/^-?\d/.test(name) || /^--/.test(name)) return false;
  if (STATE_CLASSES.has(name.toLowerCase()) || STATE_PREFIX.test(name) || STATE_SUFFIX.test(name)) return false;
  if (GENERATED_CLASS.some((pattern) => pattern.test(name))) return false;
  const module = CSS_MODULE.exec(name);
  if (module?.[1] && /[0-9A-Z]/.test(module[1])) return false;
  if (/\d{4,}/.test(name)) return false;
  if (isStyledHash(name)) return false;
  return !name.split(/[-_]+/).some((token) => looksRandomToken(token, 2));
}

/** styled-components' second class: short mixed-case gibberish such as "kDSDHk" or "fXbQqX". */
function isStyledHash(name: string): boolean {
  return /^[A-Za-z]{5,8}$/.test(name) && /[a-z]/.test(name) && /[A-Z][a-z]?[A-Z]/.test(name);
}

export function isUtilityClass(name: string): boolean {
  return UTILITY_CLASS.test(name);
}

/** Stable class names of `el` in document order, deduplicated. */
export function stableClasses(el: Element): string[] {
  const raw = el.getAttribute('class');
  if (!raw) return [];
  const out: string[] = [];
  for (const name of raw.split(/\s+/)) {
    if (name && !out.includes(name) && isStableClass(name)) {
      out.push(name);
      if (out.length >= MAX_STABLE_CLASSES) break;
    }
  }
  return out;
}

/** Semantic class names first (e.g. "revenue-card"), utility classes ("mt-4") last. */
export function rankClasses(classes: readonly string[]): string[] {
  const semantic = classes.filter((name) => !isUtilityClass(name));
  const utility = classes.filter((name) => isUtilityClass(name));
  return [...semantic, ...utility];
}
