import { isWebmarkNode } from '@/lib/constants';
import { boxContains } from './geometry';

/** Returns the page element to highlight at a viewport point, or null. */
export type HitTest = (x: number, y: number) => Element | null;

const FRAME_TAGS = ['iframe', 'embed', 'object'] as const;

/**
 * Hit-test the page, ignoring WebMark's own UI and <html>, falling back to
 * <body> only when nothing else is there. Page shadow roots are not entered
 * (their host is returned). Frames are pointer-transparent while picking (see
 * PAGE_CSS), so they are found by geometry inside the element that was hit.
 */
export function createDefaultHitTest(doc: Document = document): HitTest {
  // Live collections: cheap to iterate, and they pick up frames added later.
  const frames = FRAME_TAGS.map((tag) => doc.getElementsByTagName(tag));
  return (x, y) => {
    const hit = topPageElementAt(doc, x, y);
    return hit && (frameInside(hit, frames, x, y) ?? hit);
  };
}

function topPageElementAt(doc: Document, x: number, y: number): Element | null {
  // Fast path without allocating the full stack: usually the topmost element is page content.
  const top = doc.elementFromPoint(x, y);
  if (!top) return null;
  const topHost = outermostHost(top);
  if (isOrdinaryPageElement(topHost, doc)) return topHost;

  let body: Element | null = null;
  for (const el of doc.elementsFromPoint(x, y)) {
    const candidate = outermostHost(el);
    if (candidate === doc.body) body = candidate;
    else if (isOrdinaryPageElement(candidate, doc)) return candidate;
  }
  return body;
}

function isOrdinaryPageElement(el: Element, doc: Document): boolean {
  return el !== doc.documentElement && el !== doc.body && !isWebmarkNode(el);
}

/** Climb out of any shadow trees: we select the host, never its internals. */
function outermostHost(el: Element): Element {
  let current = el;
  for (let root = current.getRootNode(); root instanceof ShadowRoot; root = current.getRootNode()) {
    current = root.host;
  }
  return current;
}

function frameInside(
  scope: Element,
  frames: HTMLCollectionOf<Element>[],
  x: number,
  y: number,
): Element | null {
  let found: Element | null = null;
  for (const list of frames) {
    for (let i = 0; i < list.length; i++) {
      const frame = list[i];
      if (!frame || !scope.contains(frame) || isWebmarkNode(frame)) continue;
      // Later frames in document order generally paint on top, so keep the last match.
      if (boxContains(frame.getBoundingClientRect(), x, y)) found = frame;
    }
  }
  return found;
}
