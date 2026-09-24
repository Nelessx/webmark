/*
 * Tiny global toast store. Module-level so any component (or plain function)
 * can show a toast without a context provider; <Toaster /> renders them.
 */

export type ToastTone = 'default' | 'success' | 'danger';

export interface ToastOptions {
  tone?: ToastTone;
  /** Milliseconds before the toast disappears. */
  duration?: number;
}

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

const DEFAULT_DURATION_MS = 2600;
const MAX_VISIBLE = 3;

let items: readonly ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(next: readonly ToastItem[]) {
  items = next;
  for (const listener of listeners) listener();
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  if (items.some((t) => t.id === id)) emit(items.filter((t) => t.id !== id));
}

export function showToast(message: string, options: ToastOptions = {}): number {
  const id = nextId++;
  const item: ToastItem = { id, message, tone: options.tone ?? 'default' };
  const next = [...items, item];
  // Drop the oldest so rapid actions don't stack a wall of toasts.
  for (const old of next.slice(0, Math.max(0, next.length - MAX_VISIBLE))) {
    const timer = timers.get(old.id);
    if (timer) clearTimeout(timer);
    timers.delete(old.id);
  }
  emit(next.slice(-MAX_VISIBLE));
  timers.set(
    id,
    setTimeout(() => dismissToast(id), options.duration ?? DEFAULT_DURATION_MS),
  );
  return id;
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(): readonly ToastItem[] {
  return items;
}
