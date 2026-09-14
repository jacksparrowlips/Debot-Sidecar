import { spawn } from "node:child_process";

/** 跨平台打开浏览器（macOS `open` / Windows `start` / Linux `xdg-open`；非深度平台依赖） */
export function openBrowser(url: string): void {
  try {
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", cmd, url], { detached: true, stdio: "ignore" })
        : spawn(cmd, [url], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // 打开失败不影响服务运行（WebUI 通知窗兜底：系统通知 + 通知中心）
  }
}
