import { homedir } from "node:os";
import path from "node:path";
import {
  CONFIG_FILE_NAME,
  DATA_DIR_ENV,
  DB_FILE_NAME,
  RULES_FILE_NAME,
  SOUNDS_DIR_NAME,
  STRATEGY_FILE_NAME,
  TAGS_FILE_NAME,
} from "@debot/shared";

export interface SidecarPaths {
  dataDir: string;
  dbFile: string;
  rulesFile: string;
  tagsFile: string;
  strategyFile: string;
  configFile: string;
  soundsDir: string;
}

/** 数据目录：环境变量 DEBOT_SIDECAR_DATA_DIR 覆盖，默认 ~/.debot-sidecar（SPEC §10） */
export function resolvePaths(configuredDataDir?: string): SidecarPaths {
  const dir = process.env[DATA_DIR_ENV] ?? configuredDataDir ?? "~/.debot-sidecar";
  const dataDir = dir.startsWith("~") ? path.join(homedir(), dir.slice(1)) : path.resolve(dir);
  return {
    dataDir,
    dbFile: path.join(dataDir, DB_FILE_NAME),
    rulesFile: path.join(dataDir, RULES_FILE_NAME),
    tagsFile: path.join(dataDir, TAGS_FILE_NAME),
    strategyFile: path.join(dataDir, STRATEGY_FILE_NAME),
    configFile: path.join(dataDir, CONFIG_FILE_NAME),
    soundsDir: path.join(dataDir, SOUNDS_DIR_NAME),
  };
}
