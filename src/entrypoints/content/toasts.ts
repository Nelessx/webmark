import type { Timers } from './dom';
import type { AppStore, Toast } from './store';

const MAX_TOASTS = 3;

export class Toaster {
  private seq = 0;

  constructor(
    private readonly store: AppStore,
    private readonly timers: Timers,
  ) {}

  show(text: string, tone: Toast['tone'] = 'info'): void {
    const toast: Toast = { id: ++this.seq, text, tone };
    this.store.set((s) => ({ toasts: [...s.toasts.slice(-(MAX_TOASTS - 1)), toast] }));
    this.timers.set(() => this.dismiss(toast.id), tone === 'error' ? 4500 : 2400);
  }

  dismiss(id: number): void {
    this.store.set((s) => (s.toasts.some((t) => t.id === id) ? { toasts: s.toasts.filter((t) => t.id !== id) } : {}));
  }
}
