/** 服务数据目录与文件名（~/.debot-sidecar，SPEC §10；环境变量 DEBOT_SIDECAR_DATA_DIR 覆盖） */
export const DATA_DIR_ENV = "DEBOT_SIDECAR_DATA_DIR";
export const DB_FILE_NAME = "sidecar.db";
export const RULES_FILE_NAME = "rules.json";
export const TAGS_FILE_NAME = "tags.json";
export const STRATEGY_FILE_NAME = "strategy.json";
export const CONFIG_FILE_NAME = "config.json";
export const SOUNDS_DIR_NAME = "sounds";

/** WS 路径：扩展连接 /ext，WebUI 连接 /ui */
export const WS_PATH_EXT = "/ext";
export const WS_PATH_UI = "/ui";
