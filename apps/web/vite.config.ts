import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // 直接从 workspace 源码编译（包 exports 亦指向 TS 源，此处显式 alias 保证 dev/build 一致）
    alias: {
      "@debot/shared": path.resolve(here, "../../packages/shared/src/index.ts"),
    },
  },
  server: {
    // dev 模式代理到本地 Sidecar（同源避免 CORS；build 产物由服务托管在 8787）
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ext": { target: "ws://127.0.0.1:8787", ws: true },
      "/ui": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
});
