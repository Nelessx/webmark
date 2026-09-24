import { createContext, useContext, useSyncExternalStore } from 'react';
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

export function useBox(element: Element | null | undefined): Box | undefined {
  const { layout } = useWebmark();
  return useSyncExternalStore(layout.subscribe, () => (element ? layout.getSnapshot().boxes.get(element) : undefined));
}
