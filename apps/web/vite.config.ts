import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { proxy: {
    "/v1/rooms": {
      target: "http://127.0.0.1:8003",
      configure(proxy) {
        proxy.on("proxyReq", (proxied, request) => {
          proxied.removeHeader("forwarded");
          proxied.removeHeader("x-forwarded-for");
          proxied.removeHeader("x-forwarded-proto");
          proxied.removeHeader("x-room-client-ip");
          const peer = request.socket.remoteAddress;
          if (peer) proxied.setHeader("X-Room-Client-IP", peer);
        });
      },
    },
    "/v1/photo-captures": `http://127.0.0.1:${process.env.ROOM_PHOTO_TEST_PORT || "8002"}`,
    "/v1": "http://127.0.0.1:8001",
  } },
  test: { include: ["src/**/*.test.ts"] },
});
