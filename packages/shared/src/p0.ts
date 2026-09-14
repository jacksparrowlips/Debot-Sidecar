// P0 已证实事实与待确认值集中于此（SPEC §9）。
// 实现不得编造待确认值；P0 抓包结果出来后只改这一个文件即可接入。
export const P0 = {
  // ── 已证实（2026-09-13/14 实测抓包，SPEC 附录 A；rank 轮询频率：数秒一次，max_price_gain 随之实时更新）──
  AI_SIGNAL_PAGE_URL: "https://debot.ai/?chain=bsc", // 页面地址（chain 为页面级筛选）
  AI_SIGNAL_URL_MATCH: "https://debot.ai/*", // content script match pattern
  SIGNAL_API_PREFIX: "https://debot.ai/api/community/signal/", // hook 白名单前缀（rank 轮询 + token/kline 均在此前缀下）
  SIGNAL_SCHEMA_VERSION: 1, // v1 = activity/rank 结构（附录 A）
  DEDUP_KEY_GRANULARITY: "token_address", // 按 address 差分
  NEW_SIGNAL_HINT_ENDPOINT: "/api/community/signal/channel/token/kline", // 新信号弹出时最先请求的端点（先行线索；完整字段仍以 rank 差分为权威）
  MAX_PRICE_GAIN_UNIT: "pct" as "x" | "pct", // 数值×100=页面百分比（8.561333→856%）；"基价倍数/涨幅"语义 P1 以 kline 峰值对照定稿
  LOGIN_FAIL_MODE: "cloudflare_challenge", // 登录/风控失效=Cloudflare 人机验证页（需用户点击，附录 A）
  TOKEN_URL_TEMPLATE: "https://debot.ai/token/{chain}/246559_{ca}", // token 详情页（2026-09-14 用户确认：下划线前数字固定为 246559；{chain}/{ca} 取自信号属性）
  // ── 待确认 ──
  LOGIN_FAIL_SIGNATURES: ["Just a moment"], // CF 挑战页 DOM/标题特征（候选：title "Just a moment…"，P1 实测定稿）
  L0_IS_TRUSTED_EFFECTIVE: null as boolean | null, // L0 合成事件是否有效（静置 30 分钟实测，唯一剩余 P0 待办）
} as const;

/** 服务默认监听端口（HTTP/REST/WS/WebUI 同端口，仅 127.0.0.1，可经 config 修改） */
export const DEFAULT_SERVER_PORT = 8787;
