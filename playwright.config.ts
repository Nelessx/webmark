import { defineConfig } from '@playwright/test';

/*
 * End-to-end tests: the real extension (built with `wxt build --mode e2e`) in
 * Playwright's bundled Chromium. Run with `npm run test:e2e`; set HEADED=1 to
 * watch. The browser is shared by all tests, so they run one at a time.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  outputDir: 'test-results',
});
