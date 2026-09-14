import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  DEFAULT_RULESET,
  DEFAULT_STRATEGY,
  DEFAULT_TAG_LIBRARY,
  type Ruleset,
  type SidecarConfig,
  type Strategy,
  type TagLibrary,
} from "@debot/shared";
import type { SidecarPaths } from "./paths.js";

// ─────────────────────────── 低层 JSON 读写 ───────────────────────────

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ─────────────────────────── 深合并（配置文件缺失字段用默认值补齐） ───────────────────────────

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return patch as T;
  if (typeof patch !== "object" || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b !== undefined ? deepMerge(b, v) : v;
  }
  return out as T;
}

// ─────────────────────────── config.json ───────────────────────────

export function loadConfig(paths: SidecarPaths): SidecarConfig {
  const file = readJson<Partial<SidecarConfig>>(paths.configFile);
  const merged = deepMerge(DEFAULT_CONFIG, file);
  // dataDir 由 paths 解析结果为准（环境变量 > 文件值 > 默认）
  merged.dataDir = process.env.DEBOT_SIDECAR_DATA_DIR ?? file?.dataDir ?? DEFAULT_CONFIG.dataDir;
  return merged;
}

export function saveConfig(paths: SidecarPaths, config: SidecarConfig): void {
  writeJson(paths.configFile, config);
}

// ─────────────────────────── rules.json / tags.json / strategy.json ───────────────────────────

/** 规则：不存在时落默认预置包（含相关性预置规则，SPEC §7.3/§7.4） */
export function loadRuleset(paths: SidecarPaths): Ruleset {
  return readJson<Ruleset>(paths.rulesFile) ?? structuredClone(DEFAULT_RULESET);
}

/** 保存规则（version 由服务端递增，生成新版本快照，SPEC §7.3） */
export function saveRuleset(paths: SidecarPaths, ruleset: Ruleset, nextVersion: number): Ruleset {
  const saved: Ruleset = { ...ruleset, version: nextVersion };
  writeJson(paths.rulesFile, saved);
  return saved;
}

export function loadTags(paths: SidecarPaths): TagLibrary {
  return readJson<TagLibrary>(paths.tagsFile) ?? structuredClone(DEFAULT_TAG_LIBRARY);
}

export function saveTags(paths: SidecarPaths, tags: TagLibrary): void {
  writeJson(paths.tagsFile, tags);
}

export function loadStrategy(paths: SidecarPaths): Strategy {
  return readJson<Strategy>(paths.strategyFile) ?? structuredClone(DEFAULT_STRATEGY);
}

/** 保存策略（版本化，与规则版本分开，SPEC §7.10） */
export function saveStrategy(paths: SidecarPaths, strategy: Strategy, nextVersion: number): Strategy {
  const saved: Strategy = { ...strategy, strategyVersion: nextVersion };
  writeJson(paths.strategyFile, saved);
  return saved;
}

/** 启动时保证数据目录 / sounds 目录存在 */
export function ensureDirs(paths: SidecarPaths): void {
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.soundsDir, { recursive: true });
}
