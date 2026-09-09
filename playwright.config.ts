import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  retries: 0,
  use: { baseURL: "http://127.0.0.1:5179", trace: "retain-on-failure" },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 5179 --strictPort",
    url: "http://127.0.0.1:5179/codex-web/",
    reuseExistingServer: !process.env.CI,
  },
});
