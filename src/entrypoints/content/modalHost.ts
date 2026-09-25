import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { AppStore } from './store';

type Movable = Element & { moveBefore?(node: Node, child: Node | null): void };

const MAX_READOPT = 50;

/** The last open modal <dialog> in document order (the usual nesting order). */
function topModalDialog(): HTMLDialogElement | null {
  let top: HTMLDialogElement | null = null;
  for (const dialog of document.querySelectorAll('dialog')) {
    try {
      if (dialog.matches(':modal')) top = dialog;
    } catch {
      // No :modal support: nothing we can tell apart.
    }
  }
  return top;
}

/**
 * moveBefore() moves an element without taking it out of the document, so
 * the editor frame inside keeps running (Chrome 133+). Elsewhere the frame
 * reloads and the editor reconnects (EditorController.frameFailed).
 */
function move(host: HTMLElement, parent: Element): void {
  if (host.parentNode === parent) return;
  const moveBefore = (parent as Movable).moveBefore;
  if (typeof moveBefore === 'function' && host.isConnected && parent.isConnected) {
    try {
      moveBefore.call(parent, host, null);
      return;
    } catch {
      // Fall back to a plain move.
    }
  }
  parent.append(host);
}

/**
 * A page's modal <dialog> (showModal()) makes the rest of the document
 * inert, WebMark's host included: pins, the picker's controls and the editor
 * could not be clicked or focused, so nothing in the dialog could get a note.
 * While a modal dialog is open WebMark's host lives inside it (its UI still
 * renders in the top layer, `raise`d above the dialog) and the store's
 * `modal` limits pins and outlines to the dialog's content. When the dialog
 * closes the host goes back to <body>.
 */
export class ModalHost {
  private dialog: HTMLDialogElement | null = null;
  private readopted = 0;
  /** Only while a dialog is open: puts our host back if the page moves or removes it. */
  private readonly watcher = new MutationObserver(() => this.update());

  constructor(
    private readonly ctx: ContentScriptContext,
    private readonly store: AppStore,
    private readonly host: HTMLElement,
    private readonly raise: () => void,
  ) {
    // showModal() and close() set and remove the `open` attribute; `close` doesn't bubble.
    const opened = new MutationObserver(() => this.update());
    opened.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });
    ctx.addEventListener(document, 'close', () => this.update(), { capture: true });
    ctx.onInvalidated(() => {
      opened.disconnect();
      this.watcher.disconnect();
    });
    this.update();
  }

  /** Follow the topmost open modal dialog, or go back to <body>. */
  update(): void {
    if (this.ctx.isInvalid) return;
    const dialog = topModalDialog();
    const home = dialog ?? document.body ?? document.documentElement;
    if (dialog === this.dialog && this.host.parentNode === home) return;
    if (dialog !== this.dialog) this.readopted = 0;
    else if (++this.readopted > MAX_READOPT) return;
    this.dialog = dialog;
    move(this.host, home);
    this.watcher.disconnect();
    if (dialog) this.watcher.observe(document.documentElement, { childList: true, subtree: true });
    this.store.set({ modal: dialog });
    this.raise();
  }
}
