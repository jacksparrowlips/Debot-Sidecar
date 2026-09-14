import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONFIG,
  parseTokenEntry,
  type ProviderInfo,
  type Ruleset,
  type SidecarConfig,
  type SignalDetail,
  type SignalSummary,
  type SignalsPage,
  type Strategy,
  type TagLibrary,
} from "@debot/shared";
import { validateRuleset } from "@debot/rules-engine";
import { getCtx, setContext } from "../context.js";
import { saveConfig, saveRuleset, saveStrategy, saveTags } from "../config/loader.js";
import { toSummary } from "../pipeline/scoring.js";
import { computeStats } from "../stats/statsService.js";
import { getReplay, listReplays, runReplay } from "../replay/replayer.js";
import { PROVIDER_INFOS } from "../enrichment/registry.js";
import { querySignals, getSignal, getScores, getEnrichments, type SignalRow } from "../store/signals.js";
import {
  getPricePoints,
  getRuleVersions,
  getStrategyVersions,
  getTrade,
  listNotifications,
  maxRuleVersion,
  maxStrategyVersion,
  saveRuleVersion,
  saveStrategyVersion,
} from "../store/misc.js";

import { captureSnapshot, captureDetail } from "../pipeline/captureMonitor.js";
import { listSignalCards } from "../store/cards.js";
import { extConnectionCount } from "./ws.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function rowToSummary(
  row: SignalRow & { total_score: number; grade: SignalSummary["grade"] },
): SignalSummary {
  const signal = parseTokenEntry(
    JSON.parse(row.raw_payload) as Record<string, unknown>,
    row.captured_at,
    row.chain ?? "",
  );
  return toSummary(signal, row.id, row.signal_type, row.grade, row.total_score);
}

export function registerRest(app: FastifyInstance): void {
  app.get("/api/signal-cards", () => listSignalCards(getCtx().db, getCtx().config.tokenUrlTemplate));
  app.get("/api/captures", () => captureSnapshot(extConnectionCount()));
  app.get<{ Params: { id: string } }>("/api/captures/:id", (req, reply) => {
    const record = captureDetail(Number(req.params.id));
    return record ?? reply.code(404).send({ error: "记录已过期或不存在" });
  });
  // ───────────── 信号 ─────────────
  app.get("/api/signals", (req) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize ?? 50)));
    const { total, items } = querySignals(getCtx().db, {
      grade: q.grade ?? null,
      from: q.from ? Number(q.from) : null,
      to: q.to ? Number(q.to) : null,
      q: q.q ?? null,
      page,
      pageSize,
    });
    const body: SignalsPage = {
      total,
      page,
      pageSize,
      items: items.map(rowToSummary),
    };
    return body;
  });

  app.get("/api/signals/:id", (req, reply) => {
    const { db } = getCtx();
    const id = Number((req.params as { id: string }).id);
    const row = getSignal(db, id);
    if (row === null) return reply.code(404).send({ error: "not_found" });
    const scores = getScores(db, id);
    const latest = scores.length > 0 ? scores[scores.length - 1]! : null;
    const summary = rowToSummary({
      ...row,
      grade: (latest?.grade ?? "LOW") as SignalSummary["grade"],
      total_score: latest?.total_score ?? 0,
    });
    const detail: SignalDetail = {
      summary,
      raw: JSON.parse(row.raw_payload),
      scores,
      enrichments: getEnrichments(db, id),
      price_points: getPricePoints(db, row.token_address, row.captured_at),
      trade: getTrade(db, id),
    };
    return detail;
  });

  // ───────────── 规则（保存即新版本，§7.3） ─────────────
  app.get("/api/rules", () => {
    const { db, ruleset } = getCtx();
    const versions = getRuleVersions(db).map((v) => ({ ...v, current: v.version === ruleset.version }));
    return { current: ruleset, versions };
  });

  app.put<{ Body: Ruleset }>("/api/rules", (req, reply) => {
    const { db, paths } = getCtx();
    const err = validateRuleset(req.body);
    if (err !== null) return reply.code(400).send({ error: err });
    const next = maxRuleVersion(db) + 1;
    const saved = saveRuleset(paths, req.body, next);
    saveRuleVersion(db, saved, Date.now());
    setContext({ ...getCtx(), ruleset: saved });
    return { version: saved.version };
  });

  // ───────────── 相关性标签库（规则编辑器随附，§7.4/§7.11） ─────────────
  app.get("/api/tags", () => getCtx().tags);

  app.put<{ Body: TagLibrary }>("/api/tags", (req) => {
    const { paths } = getCtx();
    saveTags(paths, req.body);
    setContext({ ...getCtx(), tags: req.body });
    return { ok: true };
  });

  // ───────────── 策略（版本化，与规则版本分开，§7.10） ─────────────
  app.get("/api/strategies", () => {
    const { db, strategy } = getCtx();
    const versions = getStrategyVersions(db).map((v) => ({
      ...v,
      current: v.version === strategy.strategyVersion,
    }));
    return { current: strategy, versions };
  });

  app.put<{ Body: Omit<Strategy, "strategyVersion"> }>("/api/strategies", (req) => {
    const { db, paths } = getCtx();
    const next = maxStrategyVersion(db) + 1;
    const saved = saveStrategy(paths, { ...req.body, strategyVersion: next }, next);
    saveStrategyVersion(db, saved, Date.now());
    setContext({ ...getCtx(), strategy: saved });
    return { version: saved.strategyVersion };
  });

  // ───────────── 统计 ─────────────
  app.get("/api/stats", (req) => {
    const q = req.query as Record<string, string | undefined>;
    return computeStats(
      (q.groupBy === "rule" ? "rule" : "grade"),
      q.from ? Number(q.from) : null,
      q.to ? Number(q.to) : null,
    );
  });

  // ───────────── 回放 ─────────────
  app.post<{ Body: { from: number; to: number; ruleVersion?: number } }>("/api/replay", (req, reply) => {
    const { from, to, ruleVersion } = req.body ?? {};
    if (typeof from !== "number" || typeof to !== "number" || from >= to) {
      return reply.code(400).send({ error: "from/to 非法（需 from < to，epoch ms）" });
    }
    return runReplay(from, to, ruleVersion);
  });

  app.get("/api/replays", () => listReplays());
  app.get("/api/replays/:id", (req, reply) => {
    const r = getReplay(Number((req.params as { id: string }).id));
    if (r === null) return reply.code(404).send({ error: "not_found" });
    return r;
  });

  // ───────────── 配置（含 provider 清单） ─────────────
  app.get("/api/config", () => {
    const { config } = getCtx();
    const providers: ProviderInfo[] = PROVIDER_INFOS.map((p) => ({
      id: p.id,
      enabled: config.enrichment.providers[p.id] === true,
      reserved: "reserved" in p ? (p as { reserved: true }).reserved : false,
      description: p.description,
    }));
    return { ...config, providers };
  });

  app.put<{ Body: SidecarConfig }>("/api/config", (req) => {
    const { paths, config } = getCtx();
    const body = { ...(req.body ?? {}) } as Partial<SidecarConfig> & { providers?: unknown };
    delete body.providers; // GET 响应附带的清单回传时剔除，不落盘
    // port/dataDir 变更需重启生效；其余（notify/enrichment/keepalive/cooldown/template）热更新
    const merged: SidecarConfig = {
      ...config,
      ...body,
      port: config.port,
      dataDir: config.dataDir,
      notify: { ...config.notify, ...(body.notify ?? {}) },
      enrichment: { ...config.enrichment, ...(body.enrichment ?? {}) },
      keepalive: { ...config.keepalive, ...(body.keepalive ?? {}) },
    };
    saveConfig(paths, merged);
    setContext({ ...getCtx(), config: merged });
    return { ...merged, restartRequired: false as const };
  });

  // ───────────── 通知中心（防漏看，§7.6.4） ─────────────
  app.get("/api/notifications", () => listNotifications(getCtx().db, 200));

  // ───────────── 自定义提示音上传（§7.6.3）：存 soundsDir，经 /sounds/ 托管 ─────────────
  app.post<{ Body: { name: string; base64: string } }>("/api/sounds", (req, reply) => {
    const { name, base64 } = req.body ?? ({} as { name: string; base64: string });
    // 名字白名单化：仅字母数字-_./ 且无路径穿越
    const safe = name.replace(/[^a-zA-Z0-9\-_.]/g, "_");
    if (!/^[a-zA-Z0-9\-_.]{1,80}$/.test(safe) || safe.startsWith(".")) {
      return reply.code(400).send({ error: "非法文件名" });
    }
    try {
      const buf = Buffer.from(base64, "base64");
      if (buf.length === 0 || buf.length > 2 * 1024 * 1024) {
        return reply.code(400).send({ error: "音频需 1B–2MB" });
      }
      const { paths } = getCtx();
      fs.mkdirSync(paths.soundsDir, { recursive: true });
      fs.writeFileSync(path.join(paths.soundsDir, safe), buf);
      return { ok: true, name: safe };
    } catch {
      return reply.code(400).send({ error: "base64 解码失败" });
    }
  });

  registerStatic(app);
}

/** WebUI 构建产物 + 自定义音频目录 + SPA fallback（/notify 等前端路由） */
function registerStatic(app: FastifyInstance): void {
  const { paths } = getCtx();
  const webDist = path.resolve(here, "../../../web/dist");
  if (fs.existsSync(webDist)) {
    void app.register(fastifyStatic, { root: webDist });
    void app.register(fastifyStatic, { root: paths.soundsDir, prefix: "/sounds/", decorateReply: false });
    app.setNotFoundHandler((req, reply) => {
      // SPA fallback：非 API 路径回 index.html（BrowserRouter 前端路由）
      if (req.url.startsWith("/api/") || req.url.startsWith("/ext") || req.url.startsWith("/ui")) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async () => ({
      hint: `WebUI 未构建：先运行 pnpm build:web（当前仅 REST/WS 可用）`,
    }));
  }
}
