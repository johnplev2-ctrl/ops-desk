import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 8799);

export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // One worker, one browser: the suite is light enough and the machine stays responsive.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    // Set FV_BROWSER to a Chromium-based browser binary if the bundled Chromium will not start.
    launchOptions: { executablePath: process.env.FV_BROWSER || undefined },
  },
  webServer: {
    command: "node scripts/test-server.mjs",
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
    env: { PORT: String(PORT) },
  },
  projects: [
    { name: "unit", testMatch: /unit\/.*\.spec\.ts/ },
    { name: "phone", testMatch: /e2e\/(flow|a11y)\.spec\.ts/, use: { viewport: { width: 390, height: 844 } } },
    { name: "desktop", testMatch: /e2e\/.*\.spec\.ts/, use: { viewport: { width: 1440, height: 900 } } },
  ],
});
