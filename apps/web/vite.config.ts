import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/v1/rooms": "http://127.0.0.1:8003", "/v1/photo-captures": "http://127.0.0.1:8002", "/v1": "http://127.0.0.1:8001" } },
  test: { include: ["src/**/*.test.ts"] },
});
