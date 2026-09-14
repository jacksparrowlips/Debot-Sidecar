import { defineConfig } from "wxt";

// MV3 扩展（薄捕获层，SPEC §4：薄扩展、胖服务）
export default defineConfig({
  // 不用默认 .output/（macOS 文件选择器隐藏点开头目录，Edge 加载时找不到）
  outDir: "extension-build",
  manifest: {
    name: "DeBot Signal Sidecar",
    version: "0.1.0",
    description: "被动捕获 DeBot AI Signal 页面信号，转发本地 Sidecar 过滤分级（不自动交易）",
    permissions: ["alarms", "notifications", "storage", "sidePanel", "tabs"],
    host_permissions: ["https://debot.ai/*", "http://127.0.0.1/*"],
    // MAIN world 注入脚本需暴露给页面（content script 以 <script> 注入）
    web_accessible_resources: [
      { resources: ["injected.js"], matches: ["https://debot.ai/*"] },
    ],
    side_panel: { default_path: "sidepanel.html" },
    icons: {
      "16": "icon/16.png",
      "48": "icon/48.png",
      "128": "icon/128.png",
    },
  },
});
