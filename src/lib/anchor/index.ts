/*
 * Element anchoring: remember an element so the SAME element can be found
 * again after reloads, redeploys and layout changes — and never confidently
 * return the wrong one.
 *
 *   createAnchor(el)        capture selector, XPath and a fingerprint
 *   resolveAnchor(anchor)   selector → XPath → fuzzy scoring, or null
 *   buildLabel(el)          "Dashboard → Revenue card"
 *   describeElement(el)     "button#save.btn-primary"
 */
export { createAnchor } from './fingerprint';
export { resolveAnchor, ACCEPT_SCORE, AMBIGUITY_MARGIN, type ResolveResult } from './resolve';
export { buildLabel, describeElement } from './label';
export { scoreCandidate, prepareAnchor, scoreFeatures, type ScoreBreakdown } from './score';
export { buildSelector } from './selector';
export { buildXPath, evaluateXPath } from './xpath';
export { isStableId, isStableClass, stableClasses, looksGenerated, TEST_ID_ATTRIBUTES } from './stability';
export { collectAttributes, IDENTIFYING_ATTRIBUTES } from './attributes';
export { elementText } from './text';
export { textSimilarity } from './similarity';
