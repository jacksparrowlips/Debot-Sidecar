# @debot/simulator-core — Agent Instructions

## Overview

模拟交易引擎（SPEC §7.10）：对单个信号按策略模板（入场延迟/金额、分批止盈止损出场、滑点 + 手续费成本模型）模拟入场/出场，输出虚拟 PnL（`SimulatedTrade`）。纯函数，由服务端模拟账户循环（`apps/server/src/simulator/simulator.ts`）调用。

## Build & Run

```bash
pnpm --filter @debot/simulator-core typecheck   # tsc --noEmit
pnpm --filter @debot/simulator-core test        # vitest run（全部用例）
```

## Testing

```bash
pnpm --filter @debot/simulator-core exec vitest run tests/simulate.test.ts   # 单文件
pnpm --filter @debot/simulator-core exec vitest run -t "关键字"             # 按测试名过滤
```

- 框架：Vitest（`tests/simulate.test.ts`）
- 依赖 `@debot/shared`（`workspace:*`）
- 提交前 `pnpm --filter @debot/simulator-core test` 必须通过

## Project Structure

```
src/
├── simulate.ts   # simulateTrade（唯一实现）+ PricePointIn / SimulateInput 类型
└── index.ts      # 导出 simulateTrade 与类型
tests/
└── simulate.test.ts
```

## Code Style

- PnL 用价格比例（净值比 `netRatio`）计算，与价格单位无关，无需 SOL/USD 汇率——改成本模型时保持该性质
- 每条出场规则至多触发一次（阶梯止盈语义，`fired` Set 去重）
- 剩余本金判定用 `1e-12` 浮点容差；无数据显式返回 `status: "no_data"` 的空结果

```ts
// 净值比：p 为当前 raw 价时，1 SOL 本金买出入再全卖出的净得比例
const netRatio = (p: number): number => {
  const buy = entryPrice * (1 + slip);
  const sell = p * (1 - slip);
  return ((1 - fee) / buy) * sell * (1 - fee);
};
```

## Boundaries

- ✅ **Always do:** 改动成本/出场逻辑必须同步补 `tests/simulate.test.ts`；保留 no_data / 早退路径
- ⚠️ **Ask first:** 修改 `Strategy` 结构（`@debot/shared` 契约与服务端策略版本快照联动）；修改成本模型（影响统计口径）
- 🚫 **Never do:** 引入 I/O 或任何真实交易调用（本项目不做自动交易）；破坏纯函数性
