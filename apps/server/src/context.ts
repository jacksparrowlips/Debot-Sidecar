import type { Database as DB } from "better-sqlite3";
import type {
  Ruleset,
  ServerBroadcastMsg,
  SidecarConfig,
  Strategy,
  TagLibrary,
} from "@debot/shared";
import type { SidecarPaths } from "./config/paths.js";

/** 进程级上下文（本地单进程工具，模块单例足够） */
export interface AppContext {
  db: DB;
  paths: SidecarPaths;
  config: SidecarConfig;
  /** 当前生效规则（保存时由 REST 更新内存缓存） */
  ruleset: Ruleset;
  tags: TagLibrary;
  strategy: Strategy;
  broadcast: (msg: ServerBroadcastMsg) => void;
}

let ctx: AppContext | null = null;

export function setContext(c: AppContext): void {
  ctx = c;
}

export function getCtx(): AppContext {
  if (ctx === null) throw new Error("AppContext not initialized");
  return ctx;
}
