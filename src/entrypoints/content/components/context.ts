import { createContext, useContext, useSyncExternalStore, type CSSProperties } from 'react';
import type { UiActions } from '../controller';
import type { Box, LayoutSnapshot, LayoutTracker } from '../layout';
import type { AppState, AppStore } from '../store';

export interface WebmarkContextValue {
  store: AppStore;
  layout: LayoutTracker;
  actions: UiActions;
}

export const WebmarkContext = createContext<WebmarkContextValue | null>(null);

export function useWebmark(): WebmarkContextValue {
  const value = useContext(WebmarkContext);
  if (!value) throw new Error('WebmarkContext missing');
  return value;
}

/** Subscribe to one slice of app state. The selector must return stored values by reference. */
export function useAppState<S>(selector: (state: AppState) => S): S {
  const { store } = useWebmark();
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}

export function useLayout(): LayoutSnapshot {
  const { layout } = useWebmark();
  return useSyncExternalStore(layout.subscribe, layout.getSnapshot);
}

/**
 * Style that puts our fixed layer back on the viewport when a transformed
 * <html>/<body> displaced it (only where the top layer isn't available).
 * Subscribes to numbers only, so scrolling doesn't re-render the whole app.
 */
export function useLayerCompensation(): CSSProperties | undefined {
  const { layout } = useWebmark();
  const left = useSyncExternalStore(layout.subscribe, () => layout.getSnapshot().origin.left);
  const top = useSyncExternalStore(layout.subscribe, () => layout.getSnapshot().origin.top);
  const width = useSyncExternalStore(layout.subscribe, () => layout.getSnapshot().viewport.width);
  const height = useSyncExternalStore(layout.subscribe, () => layout.getSnapshot().viewport.height);
  if (left === 0 && top === 0) return undefined;
  return { translate: `${-left}px ${-top}px`, right: 'auto', bottom: 'auto', width, height };
}

export function useBox(element: Element | null | undefined): Box | undefined {
  const { layout } = useWebmark();
  return useSyncExternalStore(layout.subscribe, () => (element ? layout.getSnapshot().boxes.get(element) : undefined));
}
