# @debot/rules-engine — Agent Instructions

## Overview

规则 DSL 求值 + 规则集校验的纯函数包：按点分字段路径从 Signal/HistoryCtx 取值（`getField`）、条件比较（`testCondition`）、评分分级（`evaluate`/`gradeGte`）与规则集结构校验（`validateRuleset`）。服务端实时评分与历史回放共用同一实现。

## Build & Run

```bash
pnpm --filter @debot/rules-engine typecheck   # tsc --noEmit
pnpm --filter @debot/rules-engine test        # vitest run（全部用例）
```

## Testing

```bash
pnpm --filter @debot/rules-engine exec vitest run tests/evaluate.test.ts   # 单文件
pnpm --filter @debot/rules-engine exec vitest run -t "关键字"             # 按测试名过滤
```

- 框架：Vitest（`tests/evaluate.test.ts`）
- 依赖 `@debot/shared`（`workspace:*`，直接吃 TS 源）
- 提交前 `pnpm --filter @debot/rules-engine test` 必须通过

## Project Structure

```
src/
├── evaluate.ts   # getField / testCondition / evaluate / gradeGte
├── validate.ts   # validateRuleset 规则集校验
└── index.ts      # 统一导出
tests/
└── evaluate.test.ts
```

## Code Style

- 纯函数，禁止 I/O、数据库、网络与全局可变状态
- 比较语义集中在单个 `switch`（`>` / `>=` / `<` / `<=` / `=` / `!=` …），null/undefined 语义有注释兜底
- 数字判定走 `asNumber`（`Number.isFinite`）防御 NaN：

```ts
export function getField(signal: Signal, field: string, ctx?: HistoryCtx): unknown {
  const m = field.match(OCCURRENCES_RE);
  if (m) {
    return ctx?.windows[m[1] ?? ""] ?? 0;
  }
  ...
}
```

## Boundaries

- ✅ **Always do:** 任何求值/校验语义改动必须新增或更新 `tests/evaluate.test.ts` 用例
- ⚠️ **Ask first:** 修改 DSL 语义（op 集合、字段路径规则、分级映射）——影响实时评分与历史回放一致性（规则按版本快照入库）
- 🚫 **Never do:** 引入 I/O、随机性、时间依赖或新依赖（回放依赖确定性求值）
