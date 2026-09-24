import { PAGE_CSS } from './styles';

export const PAGE_STYLE_ID = 'webmark-picker-cursor';

/**
 * Add the picker's page-level <style> (crosshair cursor). This is the only
 * change the picker makes to the page's own DOM. Returns a remover.
 */
export function injectPageStyle(doc: Document): () => void {
  // A content script orphaned by an extension reload may have left one behind.
  doc.getElementById(PAGE_STYLE_ID)?.remove();
  const style = doc.createElement('style');
  style.id = PAGE_STYLE_ID;
  style.textContent = PAGE_CSS;
  (doc.head ?? doc.documentElement).append(style);
  return () => style.remove();
}
