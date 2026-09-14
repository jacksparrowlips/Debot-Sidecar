import type { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import type { ExtToServerMsg, ServerBroadcastMsg } from "@debot/shared";
import { WS_PATH_EXT, WS_PATH_UI } from "@debot/shared";

type WsLike = { send: (data: string) => void; close: () => void; ping?: () => void };

const extSockets = new Set<WsLike>();
const uiSockets = new Set<WsLike>();

/** 广播给 WebUI + 扩展 SW（signal.scored / grade.updated / notification / alert） */
export function broadcast(msg: ServerBroadcastMsg): void {
  const payload = JSON.stringify(msg);
  for (const ws of [...uiSockets, ...extSockets]) {
    try {
      ws.send(payload);
    } catch {
      // 发送失败：连接即将被 close 清理，静默
    }
  }
}

export function extConnectionCount(): number { return extSockets.size; }

export function uiConnectionCount(): number {
  return uiSockets.size;
}

/** WS 上行消息处理器（由 pipeline 注入，避免 gateway → pipeline 循环依赖） */
let onExtMessage: ((msg: ExtToServerMsg) => void) | null = null;
export function setExtMessageHandler(fn: (msg: ExtToServerMsg) => void): void {
  onExtMessage = fn;
}

export async function registerWs(app: FastifyInstance): Promise<void> {
  await app.register(websocketPlugin, { options: { maxPayload: 32 * 1024 * 1024 } });

  app.get(WS_PATH_EXT, { websocket: true }, (socket) => {
    extSockets.add(socket);
    socket.on("message", (raw?: unknown) => {
      try {
        const text =
          typeof raw === "string"
            ? raw
            : Buffer.isBuffer(raw)
              ? raw.toString("utf8")
              : Buffer.from(raw as Uint8Array).toString("utf8");
        const msg = JSON.parse(text) as ExtToServerMsg;
        onExtMessage?.(msg);
      } catch {
        // 非法消息：静默丢弃（扩展为本机可信来源，但协议异常不应崩服务）
      }
    });
    const drop = () => extSockets.delete(socket);
    socket.on("close", drop);
    socket.on("error", drop);
  });

  app.get(WS_PATH_UI, { websocket: true }, (socket) => {
    uiSockets.add(socket);
    const drop = () => uiSockets.delete(socket);
    socket.on("close", drop);
    socket.on("error", drop);
    // UI 无上行消息（服务单向广播）
  });

  // 心跳清理死连接（也帮助 MV3 SW 通过活跃 WS 保活，Chrome 116+，§7.8）
  const hb = setInterval(() => {
    for (const ws of [...uiSockets, ...extSockets]) {
      try {
        ws.ping?.();
      } catch {
        // ignore
      }
    }
  }, 30_000);
  hb.unref?.();
}
