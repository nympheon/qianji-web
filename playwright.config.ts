import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: true, timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 960 } } }, { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true } }],
  webServer: { command: 'pnpm dev --host 127.0.0.1 --port 5173', url: 'http://127.0.0.1:5173/health', reuseExistingServer: !process.env.CI, timeout: 60_000 },
});
