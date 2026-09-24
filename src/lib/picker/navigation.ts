import { isWebmarkNode } from '@/lib/constants';

/** The parent to select on ArrowUp, or null once we're a direct child of <body>. */
export function parentFor(el: Element): Element | null {
  const parent = el.parentElement;
  const doc = el.ownerDocument;
  if (!parent || parent === doc.body || parent === doc.documentElement) return null;
  return parent;
}

/** First child that actually takes up space, for ArrowDown when there's no climbed path to go back to. */
export function firstVisibleChild(el: Element): Element | null {
  for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
    if (isWebmarkNode(child)) continue;
    const rect = child.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return child;
  }
  return null;
}
