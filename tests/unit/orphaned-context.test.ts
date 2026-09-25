import { beforeEach, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { isContentMessage, listen } from '@/lib/messages';
import { onNotesChanged, onSettingsChanged } from '@/lib/storage';

/*
 * When the extension is updated or reloaded, Chrome strips `runtime`,
 * `storage`... from the old content script, and then runs its cleanup.
 * Unsubscribing used to throw there: uncaught TypeErrors in the page, and the
 * rest of the cleanup (picker, timers) was skipped.
 */

beforeEach(() => {
  fakeBrowser.reset();
});

/** Remove the extension namespaces the way an orphaned content script sees them. Returns a restore function. */
function orphanContext(): () => void {
  const api = browser as unknown as Record<string, unknown>;
  const saved = { runtime: api.runtime, storage: api.storage };
  api.runtime = undefined;
  api.storage = undefined;
  return () => Object.assign(api, saved);
}

it('removes message and storage listeners without throwing once the extension context is gone', () => {
  const offMessages = listen(isContentMessage, () => undefined);
  const offNotes = onNotesChanged(() => undefined);
  const offSettings = onSettingsChanged(() => undefined);

  const restore = orphanContext();
  try {
    expect(() => offMessages()).not.toThrow();
    expect(() => offNotes()).not.toThrow();
    expect(() => offSettings()).not.toThrow();
  } finally {
    restore();
  }
});

it('still removes the listeners while the context is alive', async () => {
  let calls = 0;
  const off = onSettingsChanged(() => calls++);
  await fakeBrowser.storage.local.set({ 'wm:settings': { pinsVisible: false } });
  expect(calls).toBe(1);
  off();
  await fakeBrowser.storage.local.set({ 'wm:settings': { pinsVisible: true } });
  expect(calls).toBe(1);
});
