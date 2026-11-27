# 压缩（compaction）用量也计费

DSH 的压缩会为摘要单独发一次 provider 请求，这次请求的用量落在 `compaction/summary` 事件上，
不在 chat 的 `assistant/*` 事件里。本工具按「一次真实请求 = 一条计费样本」折叠日志，
所以 **CostLive 的 token 与金额包含压缩**；官方 `tokenUsage` 投影（stateVersion 2）不包含。

## 1. 事件与字段

`compaction/summary.data` 带 `provider`、`model`、`usage`（见 DSH 的 compaction seam 定义；
`llmStreamCall` 表示这次摘要确实是经 `ctx.llm.stream()` 发出的一次调用）。
`usage` 与 `assistant/message` 的 usage 同形，仍是四个桶。摘要调用不写
`assistant/attempt` / `assistant/message`，因此只有 `compaction/summary` 记录它。

## 2. 折叠规则（`src/engine.mjs`）

1. `compaction/summary` 的 `usage` 自成一笔计费样本；`provider` / `model` 取事件自带值，
   缺失时才回落到当前请求路由。摘要用的模型可能和对话不同（例如对话在 A 模型、摘要走 B 模型）。
2. 压缩样本**不替换、也不被替换**：同一 turn/step 上的两次摘要各算一次
   （压缩有独立的 `compactionId`，turn/step 可能重复）。
3. `compaction/start` 关闭同 turn/step 的替换作用域：上下文溢出那次 attempt 已经上报过用量，
   压缩后重新结算时，新的 `assistant/message` 不能把它顶掉——两次请求各计一次。

## 3. 与官方投影的差异

官方 `tokenUsage` 投影只折叠 `assistant/attempt` / `assistant/message` 与 `llm/retry-started`，
看不到压缩。于是：

- 本工具的会话总量 = 官方投影 + 压缩样本（+ 上面第 2.3 条保留的溢出 attempt）；
- `--verify` 出现「本工具 > 投影」的会话，先看日志里有没有 `compaction/summary`，
  不要当成漏算，也不要为了对齐投影去减去压缩。

## 4. 防止以后重复计数

- 投影数字与日志折叠数字**不可相加**：投影本身已排除压缩，`analyzeEvents()` 的 fold 才是唯一口径。
- 若将来 DSH 升级把压缩计入 `tokenUsage`，或把摘要调用也记成 `assistant/*` 事件，
  不要在本工具里再叠一次：仍按「一次请求一条样本」去重，并同步更新 `--verify` 的基线说明。
- 压缩样本没有专属价格档：它按摘要实际使用的 provider/model 计价（订阅行、USD 行或 provider 卡）。
