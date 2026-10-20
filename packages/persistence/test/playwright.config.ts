import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.browser.ts',
  workers: 1,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    headless: true,
    launchOptions: {
      ...(process.env.ATLAS_E2E_CHROMIUM ? { executablePath: process.env.ATLAS_E2E_CHROMIUM } : {})
    }
  }
});
