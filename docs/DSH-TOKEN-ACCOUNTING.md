# DSH 的 token 统计口径

这份笔记回答一个问题：**DSH 自己怎么算 token，本工具如何与它对账。**
内容来自对安装包内 `@deepseek-ai/*` 包与真实会话日志的核对；DSH 升级后字段可能变化，
以 `node bin/dsh-cost.mjs --verify` 的现场结果为准。

## 1. 原始用量来自 provider

每条 `assistant/message` 事件的 `data.usage` 带有 provider 上报的用量：

```json
{
  "inputTokens": 638,
  "outputTokens": 353,
  "cacheReadTokens": 8704,
  "cacheWriteTokens": 0,
  "totalTokens": 9695
}
```

- `inputTokens` 是**未缓存输入**，不是总输入。
- `totalTokens` 已包含缓存读写（上例 `638 + 8704 + 353 = 9695`）。
- 流式阶段还可能在 `assistant/attempt` 的 `data.stream` 末尾放一个 `{ "type": "usage" }` chunk；
  它先到、最终 `assistant/message` 后到，因此需要替换规则（见第 3 节）。

## 2. 四个互不重叠的桶

`@deepseek-ai/dsh-token-meter` 把用量归一成四个桶：

| 桶 | 含义 | 计价 |
|---|---|---|
| `uncachedInputTokens` | 未命中缓存的输入 | 输入价 |
| `outputTokens` | 输出 | 输出价 |
| `cacheWriteTokens` | 写入缓存的输入 | 缓存写价 |
| `cacheReadTokens` | 命中缓存的输入 | 缓存读价 |

本工具直接采用这四个桶，**不做 delta 减法**：每条计费采样记录自己的桶，替换时整条覆盖。

## 3. 替换与重试（最容易算错的地方）

- **替换**：同一 `turn/step` 内，后到的用量样本替换先到的流式样本，不会重复计费。
- **重试**：`llm/retry-started` 结束替换作用域；重试的 attempt 是一笔**独立**的计费样本。
- **零用量**：全零样本不产生模型行，但仍参与替换作用域（能覆盖掉之前的流式样本）。
- **模型归属**：按采样到达时最近一次 `request/header` / `model/selection` 的 provider/model 归属；
  一个会话可以中途换模型，甚至同一步骤换模型。

`engine.mjs` 的 `analyzeEvents()` 就是这套规则的实现；`test/engine.test.mjs` 覆盖了替换、重试、
零用量与模型切换。

## 4. 持久化位置

### 会话日志

```text
~/.dsh/sessions/<编码后的工作区>/<session-id>/session.v4.jsonl.zstd
```

- 首行是不可变的 `session` 头：`id`、`createdAt`、`cwd`、`agentPreset`、`delegationDepth`，
  子代理还带 `origin: "subagent"` 与 `parentSession`。
- 标题以 `session/title` 事件追加，取最后一个。
- 文件是**多次追加的多个 zstd frame 拼接**。Node 的 `zstdDecompressSync` 只解第一帧，
  所以 `zstd.mjs` 自己按 RFC 8878 走 frame 边界，逐帧解压后拼接。
- 子代理是**独立会话**：独立日志、独立 token、独立计价。

### 投影缓存

```text
~/.dsh/storages/session_projcache/sessions/<session-id>.json
```

`record.rows.tokenUsage.val` 形如：

```json
{
  "totals": {
    "uncachedInputTokens": 14053,
    "outputTokens": 2241,
    "cacheReadTokens": 42086,
    "cacheWriteTokens": 52539
  },
  "last": { "turn": 3, "step": 2, "buckets": {} }
}
```

本工具只用它做三件事：读标题、判断运行状态、`--verify` 对账；**金额永远从日志重算**。
投影是增量 fold 并持久化的，所以历史会话的投影可能标记 `priced:false` 或数值滞后——
这不代表日志有问题，重跑 CLI 即可。

其他可用的投影字段：

```js
rows.sessionStats.val   // { openStep: number | null, turns, steps, pendingCalls }
rows.turnBoundary.val   // { lastStepBoundary: { kind: 'start' | 'end' } }
rows.subagent.val       // { identity: { mode, label, description } | null }
```

## 5. GUI 原生显示的是什么

`@deepseek-ai/dsh-client-ui-chat` 的 `UsagePill` 通过 `useProjection("tokenUsage")` 读取投影，
渲染在输入框下方的 composer dock（`conversation.composer.dock` 插槽）。它显示 token 总量与缓存命中率，
**不显示金额**——这正是本项目要补的空缺（网页面板 + 可选 CLI 报告）。

## 6. 为什么必须按事件计价

一个会话可能中途切换模型（例如从 `claude-haiku-5-5` 切到 `claude-sonnet-5-5`），
子代理、不同会话的模型也可能不同。只看会话总量无法定价，所以：

1. fold 时记录每笔采样当时的 provider/model；
2. 按模型价格分别计价；
3. 同一模型若有两档价（DeepSeek 峰谷），再按**每条采样自己的时间戳**选档。

## 7. 对账方法

```powershell
node bin/dsh-cost.mjs --verify
```

输出「N 个会话可比对 · M 个不一致」，并列出不一致的会话 id。

- 允许差异：投影是增量 fold，可能滞后于日志；运行中会话尤其明显。
- 不允许差异：同一采样金额不同 → 检查价表（`config/pricing.json`）是否与 DSH 侧口径一致，
  或峰谷判定的时区/时段被改过。
- 历史基线：曾在 14 个真实会话（含 8 个 DeepSeek 会话）上做到 CLI 与投影逐样本一致。

## 8. 计费边界

- 只按配置单价线性计算，不含批处理折扣、阶梯价、缓存 TTL 差异、退款。
- 缓存节省是估算：`(输入价 − 缓存读价) × cacheReadTokens`，按基础（谷值）价计算，仅供参考。
- 结果不是账单凭证。