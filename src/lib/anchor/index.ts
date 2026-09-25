/*
 * Element anchoring: remember an element so the SAME element can be found
 * again after reloads, redeploys and layout changes — and never confidently
 * return the wrong one.
 *
 *   createAnchor(el)        capture selector, XPath, a fingerprint, and what
 *                           else on the page looks like it (and what tells
 *                           them apart)
 *   resolveAnchor(anchor)   selector → XPath → fuzzy scoring, or null
 *   buildLabel(el)          "Dashboard → Revenue card"
 *   describeElement(el)     "button#save.btn-primary"
 *   contentFingerprint(el)  notice a kept element whose content was rewritten
 */
export { createAnchor } from './create';
export { resolveAnchor, ACCEPT_SCORE, AMBIGUITY_MARGIN, type ResolveResult } from './resolve';
export { buildLabel, describeElement } from './label';
export { scoreCandidate, prepareAnchor, scoreFeatures, type ScoreBreakdown } from './score';
export { buildSelector } from './selector';
export { buildXPath, evaluateXPath } from './xpath';
export { isStableId, isStableClass, stableClasses, looksGenerated, TEST_ID_ATTRIBUTES } from './stability';
export { collectAttributes, ANCHOR_ATTRIBUTES, IDENTIFYING_ATTRIBUTES } from './attributes';
export { elementText } from './text';
export { textSimilarity } from './similarity';
export { contentFingerprint, watchRootFor } from './live';
