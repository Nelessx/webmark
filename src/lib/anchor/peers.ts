import { WEBMARK_HOST_TAG } from '../constants';
import { tagOf } from './dom';
import { readKind } from './fingerprint';
import { sameKind, type PreparedAnchor } from './score';
import { normalizeForCompare, textShape } from './similarity';
import { elementText } from './text';

/**
 * WebMark's UI hosts, whose light DOM is not page content. The content script
 * keeps its host a direct child of <body> or <html>, so only those are
 * scanned (a whole-document search costs as much as the resolve itself on
 * some engines); callers still check a winner with isWebmarkNode().
 */
export function webmarkHosts(doc: Document): Element[] {
  const hosts: Element[] = [];
  for (const parent of [doc.documentElement, doc.body]) {
    for (let child = parent?.firstElementChild; child; child = child.nextElementSibling) {
      if (child.localName === WEBMARK_HOST_TAG) hosts.push(child);
    }
  }
  return hosts;
}

export function insideAny(el: Element, hosts: readonly Element[]): boolean {
  return hosts.some((host) => host.contains(el));
}

/**
 * Elements with tag `tag` in document order, as a plain array. Copied by index
 * after reading `length` once: some engines (jsdom) recount a live collection
 * on every `length` read, which also makes iterating it quadratic. Mixed-case
 * SVG names ("linearGradient") aren't found by a lower-case tag lookup.
 */
export function sameTagElements(doc: Document, tag: string): Element[] {
  const live = doc.getElementsByTagName(tag);
  const count = live.length;
  const out: Element[] = [];
  for (let i = 0; i < count; i++) {
    const el = live[i];
    if (el) out.push(el);
  }
  return out.length ? out : Array.from(doc.querySelectorAll('*')).filter((el) => tagOf(el) === tag);
}

/** Visit the page's same-tag elements outside WebMark's UI; stops when `visit` returns true. */
function forEachSameTag(doc: Document, tag: string, visit: (el: Element) => boolean | void): void {
  const hosts = webmarkHosts(doc);
  for (const el of sameTagElements(doc, tag)) {
    if (hosts.length && insideAny(el, hosts)) continue;
    if (visit(el)) return;
  }
}

/** Elements that could be mistaken for the anchored one, by how. */
export interface Peers {
  /** Same kind, same text: only position (or their item) tells them apart. */
  twins: Element[];
  /** Same kind, text differing only in its numbers ("Order #1001" / "Order #1002"). */
  numbered: Element[];
}

/** Whitespace is collapsed, so two characters past the anchor text are enough to see a longer text. */
function equalityPrefix(p: PreparedAnchor): number {
  return p.text.text.length + 2;
}

/** Look-alikes of `el` on its page; `p` is el's freshly captured anchor. */
export function findPeers(p: PreparedAnchor, el: Element): Peers {
  const peers: Peers = { twins: [], numbered: [] };
  // Numbered look-alikes need the whole text; twins only need to compare equal.
  const max = p.text.hasDigits ? undefined : equalityPrefix(p);
  forEachSameTag(el.ownerDocument, p.tagName, (other) => {
    if (other === el || !sameKind(p, readKind(other))) return;
    const text = normalizeForCompare(elementText(other, max));
    if (text === p.text.text) peers.twins.push(other);
    else if (p.text.hasDigits && textShape(text) === p.text.shape) peers.numbered.push(other);
  });
  return peers;
}

/** Elements on the page now that look exactly like the anchored one (including it), counted up to `limit`. */
export function countLookAlikes(p: PreparedAnchor, doc: Document, limit: number): number {
  const max = equalityPrefix(p);
  let count = 0;
  forEachSameTag(doc, p.tagName, (other) => {
    if (!sameKind(p, readKind(other)) || normalizeForCompare(elementText(other, max)) !== p.text.text) return;
    count++;
    return count >= limit;
  });
  return count;
}
