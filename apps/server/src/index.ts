import Fastify from "fastify";
import {
  ensureDirs,
  loadConfig,
  loadRuleset,
  loadStrategy,
  loadTags,
} from "./config/loader.js";
import { resolvePaths } from "./config/paths.js";
import { setContext } from "./context.js";
import { broadcast, registerWs, setExtMessageHandler } from "./gateway/ws.js";
import { registerRest } from "./gateway/rest.js";
import { handleExtMessage } from "./pipeline/handleCapture.js";
import { openDb } from "./store/db.js";
import { maxRuleVersion, maxStrategyVersion, saveRuleVersion, saveStrategyVersion } from "./store/misc.js";
import { startPriceTracker } from "./price/tracker.js";
import { startSimulatorLoop } from "./simulator/simulator.js";
import { openBrowser } from "./util/open.js";

async function main(): Promise<void> {
  const paths = resolvePaths();
  ensureDirs(paths);
  const db = openDb(paths.dbFile);
  const config = loadConfig(paths);

  // 规则/标签/策略：文件为用户可编辑入口；首次启动落默认值并入库版本快照（幂等）
  const ruleset = loadRuleset(paths);
  if (ruleset.version > maxRuleVersion(db)) saveRuleVersion(db, ruleset, Date.now());
  const strategy = loadStrategy(paths);
  if (strategy.strategyVersion > maxStrategyVersion(db)) {
    saveStrategyVersion(db, strategy, Date.now());
  }
  const tags = loadTags(paths);

  setContext({ db, paths, config, ruleset, tags, strategy, broadcast });
  setExtMessageHandler(handleExtMessage);

  const app = Fastify({ logger: { level: "info" } });
  await registerWs(app);
  registerRest(app);

  // 后台任务：price-tracker 补价 + 模拟账户重算
  startPriceTracker();
  startSimulatorLoop();

  await app.listen({ port: config.port, host: "127.0.0.1" });

  // 服务启动时若 WebUI 未开，自动打开通知小窗（§7.6.5）；系统通知与通知中心兜底
  openBrowser(`http://127.0.0.1:${config.port}/notify`);

  const shutdown = async (sig: string): Promise<void> => {
    app.log.info(`收到 ${sig}，关闭服务…`);
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", (sig) => void shutdown(sig));
  process.on("SIGTERM", (sig) => void shutdown(sig));

  app.log.info(
    `DeBot Sidecar 就绪 → http://127.0.0.1:${config.port}（WS /ext /ui）｜数据目录 ${paths.dataDir}`,
  );
}

void main().catch((err: unknown) => {
  console.error("启动失败:", err);
  process.exit(1);
});
