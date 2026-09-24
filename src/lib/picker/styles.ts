/**
 * Styles for the picker overlay. Rendered inside WebMark's shadow root, which
 * defines the --wm-* tokens; fallbacks keep the highlight visible if it doesn't.
 * `all: initial` on the root stops the page's inherited text styles (font
 * size, line height, text-transform...) from leaking in through the host.
 */
export const PICKER_CSS = `
.wm-picker {
  all: initial;
  display: block;
  position: fixed;
  top: 0;
  left: 0;
  right: auto;
  bottom: auto;
  width: 0;
  height: 0;
  margin: 0;
  padding: 0;
  border: 0;
  overflow: visible;
  background: transparent;
  z-index: 2147483647;
  pointer-events: none;
  direction: ltr;
  font-family: var(--wm-font, system-ui, sans-serif);
  font-size: 12px;
  line-height: 16px;
  color: var(--wm-text, #1b1b24);
  -webkit-font-smoothing: antialiased;
}
.wm-picker::backdrop {
  display: none;
  pointer-events: none;
}
.wm-picker * {
  box-sizing: border-box;
  pointer-events: none;
}
.wm-picker [hidden] {
  display: none !important;
}

.wm-picker-box {
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  border: 2px solid var(--wm-highlight, #5b4cf5);
  border-radius: 3px;
  background: var(--wm-highlight-fill, rgba(91, 76, 245, 0.1));
  transition: transform 70ms ease-out, width 70ms ease-out, height 70ms ease-out;
  will-change: transform;
}

.wm-picker-tip {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 420px;
  padding: 4px 8px;
  border: 1px solid var(--wm-border, #e3e3ec);
  border-radius: var(--wm-radius-sm, 6px);
  background: var(--wm-surface, #ffffff);
  box-shadow: var(--wm-shadow, 0 4px 16px rgba(20, 20, 40, 0.1));
  white-space: nowrap;
  transition: transform 70ms ease-out;
  will-change: transform;
}
.wm-picker-tip-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--wm-font-mono, ui-monospace, monospace);
  font-weight: 600;
  color: var(--wm-accent, #5b4cf5);
}
.wm-picker-tip-size {
  flex: none;
  color: var(--wm-text-muted, #6b6b7b);
  font-variant-numeric: tabular-nums;
}

.wm-picker--instant .wm-picker-box,
.wm-picker--instant .wm-picker-tip {
  transition: none;
}

.wm-picker-hint {
  position: fixed;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100vw - 32px);
  padding: 8px 14px;
  overflow: hidden;
  border: 1px solid var(--wm-border, #e3e3ec);
  border-radius: 999px;
  background: var(--wm-surface, #ffffff);
  box-shadow: var(--wm-shadow-lg, 0 12px 40px rgba(20, 20, 40, 0.18));
  color: var(--wm-text, #1b1b24);
  white-space: nowrap;
}
.wm-picker-hint--top {
  top: 16px;
  bottom: auto;
}
.wm-picker-hint-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--wm-accent, #5b4cf5);
  box-shadow: 0 0 0 3px var(--wm-accent-soft, rgba(91, 76, 245, 0.12));
}
.wm-picker-hint-sep {
  color: var(--wm-text-muted, #6b6b7b);
}
.wm-picker-hint kbd {
  display: inline-block;
  min-width: 20px;
  margin: 0;
  padding: 0 5px;
  border: 1px solid var(--wm-border-strong, #cfcfdc);
  border-radius: 4px;
  background: var(--wm-surface-2, #f1f1f6);
  color: var(--wm-text, #1b1b24);
  font-family: var(--wm-font-mono, ui-monospace, monospace);
  font-size: 11px;
  line-height: 16px;
  text-align: center;
}

@media (prefers-reduced-motion: reduce) {
  .wm-picker-box,
  .wm-picker-tip {
    transition: none;
  }
}
`;

/**
 * Injected into the page's own <head> while picking. Besides the crosshair,
 * embedded frames are made transparent to the pointer: otherwise clicks over
 * an iframe would go to the frame's document (which we can't intercept) and
 * the embedded content would react. Hit-testing finds frames geometrically.
 */
export const PAGE_CSS = `
*, *::before, *::after { cursor: crosshair !important; }
iframe, embed, object { pointer-events: none !important; }
`;
