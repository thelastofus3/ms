import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
const webPort = process.env.ROOM_WEB_TEST_PORT || "5173";
const photoPort = process.env.ROOM_PHOTO_TEST_PORT || "8002";
export default defineConfig({
  testDir: "./tests",
  // The MPFB workspace was retired from the public app; keep its source tests as history.
  testIgnore: "**/studio.spec.ts",
  use: {
    channel: "chromium",
    launchOptions: {
      args: process.platform === "win32" ? ["--use-angle=d3d11"] : [],
    },
    baseURL: `http://127.0.0.1:${webPort}`,
    viewport: { width: 1400, height: 1000 },
  },
  webServer: [{
    command: `npm run dev -- --port ${webPort} --strictPort`,
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: true,
  }, {
    command: `${process.platform === "win32" ? `"${resolve("../../.venv/Scripts/python.exe")}"` : "python3"} "${resolve("../../services/avatar/tests/photo_browser_server.py")}"`,
    url: `http://127.0.0.1:${photoPort}/health`,
    reuseExistingServer: false,
  }],
  timeout: 30000,
});
