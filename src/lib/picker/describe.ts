import { describeElement } from '@/lib/anchor';

/** Tooltip label for an element. Never throws: falls back to "tag#id.class" if the anchor module fails. */
export function safeDescribe(el: Element): string {
  try {
    const text = describeElement(el);
    if (text) return text;
  } catch {
    // Fall through: a bad label must not break picking.
  }
  return basicDescription(el);
}

function basicDescription(el: Element): string {
  let text = el.localName;
  if (el.id) text += `#${el.id}`;
  const classes = el.classList;
  for (let i = 0; i < classes.length && i < 2; i++) text += `.${classes[i]}`;
  return text;
}
