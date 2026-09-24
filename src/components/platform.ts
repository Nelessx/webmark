import { browser } from 'wxt/browser';

/**
 * Copy text to the clipboard. Falls back to a hidden textarea + execCommand
 * because the async Clipboard API can be unavailable or rejected in some
 * extension contexts (e.g. an unfocused side panel).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyWithTextarea(text);
  }
}

function copyWithTextarea(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.append(textarea);
  const previous = document.activeElement as HTMLElement | null;
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  textarea.remove();
  previous?.focus?.();
  return ok;
}

/** Whether this browser can open WebMark's side panel (Chromium) or sidebar (Firefox). */
export function canOpenSidePanel(): boolean {
  const api = browser as unknown as {
    sidePanel?: { open?: unknown };
    sidebarAction?: { open?: unknown };
  };
  if (import.meta.env.FIREFOX) return typeof api.sidebarAction?.open === 'function';
  return typeof api.sidePanel?.open === 'function';
}

/** True on macOS, where shortcuts are shown with ⌥ ⇧ ⌘ glyphs. */
export function isMac(): boolean {
  return /mac/i.test(navigator.platform || navigator.userAgent);
}

const MAC_KEY_GLYPHS: Record<string, string> = {
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
  command: '⌘',
  cmd: '⌘',
  // WebExtension shortcuts: "Ctrl" means Command on macOS, "MacCtrl" means Control.
  ctrl: '⌘',
  macctrl: '⌃',
};

/**
 * Split a shortcut such as "Alt+Shift+M" (or Chrome's macOS form "⌥⇧M") into
 * the keys to display.
 */
export function shortcutKeys(shortcut: string, mac = isMac()): string[] {
  const trimmed = shortcut.trim();
  if (!trimmed) return [];
  if (!trimmed.includes('+')) {
    // Already glyphs ("⌥⇧M"): one key per character, except a trailing named key.
    const match = /^([⌃⌥⇧⌘]*)(.+)$/.exec(trimmed);
    if (!match) return [trimmed];
    return [...(match[1] ?? ''), match[2] ?? ''].filter(Boolean);
  }
  return trimmed
    .split('+')
    .map((key) => key.trim())
    .filter(Boolean)
    .map((key) => (mac ? MAC_KEY_GLYPHS[key.toLowerCase()] ?? key : key));
}
