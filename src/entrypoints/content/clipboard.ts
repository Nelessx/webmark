/**
 * Copy text to the clipboard. The async Clipboard API is missing on insecure
 * (http) pages and can be blocked by permissions policy, so fall back to the
 * legacy execCommand path with a hidden textarea inside our shadow root.
 */
export async function copyText(text: string, fallbackContainer: HTMLElement): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  return legacyCopy(text, fallbackContainer);
}

function legacyCopy(text: string, container: HTMLElement): boolean {
  const root = container.getRootNode() as Document | ShadowRoot;
  const previouslyFocused = root.activeElement as HTMLElement | null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  container.append(textarea);
  let ok = false;
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    textarea.remove();
    previouslyFocused?.focus?.({ preventScroll: true });
  }
  return ok;
}
