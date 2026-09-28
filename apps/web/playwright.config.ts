import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  // The MPFB workspace was retired from the public app; keep its source tests as history.
  testIgnore: "**/studio.spec.ts",
  use: {
    channel: "chromium",
    launchOptions: {
      args: process.platform === "win32" ? ["--use-angle=d3d11"] : [],
    },
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1400, height: 1000 },
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
  },
  timeout: 30000,
});
