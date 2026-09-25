/*
 * Imported first by the content script, before React DOM is evaluated.
 *
 * WebMark only runs in HTML documents (main() declines the rest), but the
 * browser still loads the script into XML documents such as RSS feeds and
 * SVG files. There React DOM's load-time probe `document.createElement('div').style`
 * gets a plain XML element without `style` and throws, logging an error on
 * every such page. (Chrome's XML viewer even gives these documents an HTML
 * root element, so the root is no guide; the content type is.) In non-HTML
 * documents, make createElement build HTML elements instead. This only
 * changes the `document` wrapper of WebMark's isolated world; the page's own
 * scripts never see it.
 */
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/** Documents whose createElement() makes HTML elements: the only ones WebMark runs in. */
export function isHtmlDocument(doc: Document): boolean {
  return doc.contentType === 'text/html' || doc.contentType === 'application/xhtml+xml';
}

if (typeof document !== 'undefined' && !isHtmlDocument(document)) {
  const createElementNS = document.createElementNS.bind(document);
  Object.defineProperty(document, 'createElement', {
    configurable: true,
    value: (tagName: string) => createElementNS(HTML_NAMESPACE, tagName),
  });
}
