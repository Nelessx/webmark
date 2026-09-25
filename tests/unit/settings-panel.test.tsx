import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { SettingsPanel } from '@/entrypoints/options/SettingsPanel';
import { getSettings, saveSettings } from '@/lib/storage';

/*
 * The "All notes" settings panel. It used to render nothing at all once the
 * settings had loaded (it read useSettings()' `ready` flag as `loading`).
 */

let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  fakeBrowser.reset();
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  root?.unmount();
  root = null;
  container.remove();
});

function switchNamed(label: string): HTMLButtonElement {
  const wrapper = [...container.querySelectorAll('label.wm-switch')].find((el) => el.textContent?.includes(label));
  const button = wrapper?.querySelector<HTMLButtonElement>('[role="switch"]');
  if (!button) throw new Error(`No switch "${label}"`);
  return button;
}

it('shows the stored settings once they have loaded', async () => {
  await saveSettings({ captureScreenshots: false, pinsVisible: true, authorName: 'Dana' });
  root = createRoot(container);
  root.render(<SettingsPanel />);

  await vi.waitFor(() => expect(container.querySelector('section[aria-label="Settings"]')).not.toBeNull());
  expect(switchNamed('Save a screenshot').getAttribute('aria-checked')).toBe('false');
  expect(switchNamed('Show note pins').getAttribute('aria-checked')).toBe('true');
  // The name field's draft is synced from the stored value by an effect.
  await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Dana'));
});

it('saves a switch change', async () => {
  root = createRoot(container);
  root.render(<SettingsPanel />);
  await vi.waitFor(() => expect(container.querySelector('[role="switch"]')).not.toBeNull());

  switchNamed('Save a screenshot').click();
  await vi.waitFor(async () => expect((await getSettings()).captureScreenshots).toBe(false));
  await vi.waitFor(() => expect(switchNamed('Save a screenshot').getAttribute('aria-checked')).toBe('false'));
});
