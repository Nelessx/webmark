import { DOCUMENT_NODE, ELEMENT_NODE } from './dom';

const HTML_NS = 'http://www.w3.org/1999/xhtml';
/** XPathResult.FIRST_ORDERED_NODE_TYPE */
const FIRST_ORDERED_NODE_TYPE = 9;

/**
 * Absolute XPath such as /html/body/div[2]/main/section[1]/div[3]. The index is
 * written only when the element has same-tag siblings; SVG/MathML steps are
 * written "*[n]" (n counts all element siblings). Elements inside a
 * shadow root get a path relative to that root, which simply won't resolve
 * from the document.
 */
export function buildXPath(el: Element): string {
  const steps: string[] = [];
  for (let current: Element | null = el; current; current = current.parentElement) {
    steps.push(xpathStep(current));
  }
  return `/${steps.reverse().join('/')}`;
}

function isPlainHtml(el: Element): boolean {
  return el.namespaceURI === HTML_NS && el.ownerDocument.contentType !== 'application/xhtml+xml';
}

function xpathStep(el: Element): string {
  const parent = el.parentNode;
  const html = isPlainHtml(el);
  if (!parent || parent.nodeType === DOCUMENT_NODE) return html ? el.localName : '*';
  let sameTagIndex = 0;
  let sameTagCount = 0;
  let elementIndex = 0;
  let elementCount = 0;
  for (let sibling = (parent as ParentNode).firstElementChild; sibling; sibling = sibling.nextElementSibling) {
    elementCount++;
    if (sibling === el) elementIndex = elementCount;
    if (sibling.localName === el.localName && sibling.namespaceURI === el.namespaceURI) {
      sameTagCount++;
      if (sibling === el) sameTagIndex = sameTagCount;
    }
  }
  // Unprefixed name tests don't match SVG/MathML elements in HTML documents,
  // and local-name() breaks some engines (jsdom), so those use "*[n]".
  if (!html) return `*[${elementIndex}]`;
  return sameTagCount > 1 ? `${el.localName}[${sameTagIndex}]` : el.localName;
}

/** The element an XPath points to in `doc`, or null (invalid expression, no match, non-element). */
export function evaluateXPath(xpath: string, doc: Document): Element | null {
  if (!xpath || typeof doc.evaluate !== 'function') return null;
  try {
    const node = doc.evaluate(xpath, doc, null, FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    return node && node.nodeType === ELEMENT_NODE ? (node as Element) : null;
  } catch {
    return null;
  }
}
