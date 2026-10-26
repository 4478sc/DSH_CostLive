# 架构说明

面向要改代码的人：数据怎么流、模块各自负责什么、哪些不变量不能破。

## 1. 一次刷新的完整链路

```text
浏览器 (live-client.js)
   │  每 20 s GET /api/fragment
   ▼
live-server.mjs ── 串行化 / 1 s 内合并重复请求
   │
   ▼
live.mjs :: collectLiveReport(options)
   │  resolveHome：--home → $DSH_HOME → ~/.dsh
   │
   ├─ sessions.mjs  discoverSessions()      枚举 <home>/sessions/*/*/session.v4.jsonl.zstd
   │      └─ zstd.mjs  decompressZstdFrames()  逐 frame 解压（Node 只解第一帧）
   │      └─ readSession()                     header / title / 可选投影缓存
   │
   ├─ engine.mjs  analyzeEvents(events, pricing)
   │      └─ 同 turn/step 替换、llm/retry-started 断点、记录每个采样的 provider/model/time
   │      └─ pricing.mjs  costMicroCny()      每条采样按自身时间戳选峰/谷价
   │
   └─ report-data.mjs  buildReport()          会话记录、summary、模型汇总、数据集
          └─ buildDailyReport()               采样按本地日历日聚合（跨天会话拆分）
          │
          ▼
   report-html.mjs  renderHtml(report)        自包含 HTML（内联 CSS + 时间范围运行时 + 数据集）
          │
   live.mjs  splitReportHtml()                取出 <style> 与 .wrap
   renderLiveFragment() → { html, summary, generatedAt }
          │
   ▼
浏览器：替换 #live-wrap，重放时间范围/折叠/滚动/展开状态
```

`--watch` / `--once` 不经过 HTTP：同一份 `renderLiveDocument()` 直接写文件（临时文件 + 原子重命名）。

## 2. 模块职责

| 模块 | 职责 | 不该做的事 |
|---|---|---|
| `sessions.mjs` | 发现会话、读 header/title、读投影缓存 | 不做计价 |
| `zstd.mjs` | 解析 zstd frame 边界并逐帧解压 | 不解析 JSON 语义 |
| `engine.mjs` | 事件 → 计费采样（替换/重试规则）与四桶聚合 | 不决定展示格式 |
| `pricing.mjs` | 价表归一、模型匹配、峰谷判定、整数 micro-CNY | 不读会话日志 |
| `activity.mjs` | 运行中/子代理判定与排序比较器 | 不改变费用 |
| `time-range.mjs` | 四档筛选、按天视图的自然日边界/聚合、浏览器运行时源码 | 不发请求、不碰 DSH |
| `report-data.mjs` | 会话记录、按天桶、summary、数据集、CSV | 不拼 HTML |
| `report-text.mjs` | 终端表格 / 单会话明细 | — |
| `report-html.mjs` | 自包含报告、折叠、范围选择器、内嵌数据集 | 不重新实现筛选规则（调用 time-range） |
| `live.mjs` | 实时页文档/片段、原子写入 | 不重复实现采集 |
| `live-server.mjs` | HTTP、路由、请求合并、健康检查 | 不重复实现渲染 |
| `live-client.js` | 轮询/重载、浮窗、状态恢复、DOM 交互 | 不实现筛选规则（用注入的运行时） |

## 3. 关键不变量

1. **先筛选、后分页。** 时间范围先剔除会话，再对幸存者按 5 条分页；否则「还有 N 个」会把范围外会话算进去。
2. **逐采样判峰谷。** `costMicroCny(buckets, price, event.time)` 的第三参数不可省略；跨峰谷会话必须分段计价。
   无有效时间戳时按谷值（未知时钟不抬高账单）。
3. **筛选规则只有一份。** `time-range.mjs` 同时提供 Node 函数与 `timeRangeRuntimeSource()` 序列化源码；
   页面运行时、静态报告、实时页都执行同一份实现。不要在 `report-html.mjs` / `live-client.js` 里复制判断。
4. **运行状态以 `sessionStats.openStep` 为准。** 字段存在时 `!== null` 即运行中；字段缺失才回退
   `turnBoundary.lastStepBoundary.kind === 'start'`。子代理看 `subagent.identity`，投影未落盘时看日志头 `origin`。
5. **缺日期的会话永不隐藏。** 没有/非法 `createdAt` 的会话不参与剔除——宁可多显示，不能藏真实花费。
6. **替换与重试的语义固定。** 同 `turn/step` 后到的样本覆盖先到的流式样本；`llm/retry-started` 关闭替换作用域，
   重试是新的一笔。这与 DSH `tokenUsage` 投影一致，是 `--verify` 能对账的前提。
7. **金额以 micro-CNY 整数累计。** 先 `Math.round` 到 1e-6 元再求和，展示时才除 1e6；避免浮点漂移。
8. **实时页不复制样式。** 页面直接取 `renderHtml()` 的 `<style>` 与 `.wrap`，所以报告与面板永远同款。
9. **写文件必须原子。** 先写 `<target>.<pid>.<ts>.tmp` 再 rename；Windows 上 rename 可能失败，回退直接写。
10. **按天桶之和等于会话总计。** `buildDailyReport()` 只搬动采样、不改金额；跨天会话拆分后，
    所有日桶的 token/费用之和必须与 `report.summary` 严格相等。无时间戳的采样进 `dayStart: 0`
    的未知桶，只在 All time 显示。按天视图的范围判定用自然日（`rangeDayCutoff`），不要复用
    `rangeCutoff` 的滚动 24h 边界。

## 4. 服务端行为

- 每次 `/api/fragment` 都重新扫描并计价（`scans` 计数可见）；一次扫描在普通 DSH home 上约 100–300 ms。
- 1 秒内的重复请求合并为同一次扫描结果，避免多标签页叠加磁盘压力。
- `/api/report` 与 `report --format json` 同源；`/api/health` 暴露 `lastScanMs` / `lastError` / `stale`。
- 服务只读，不提供目录浏览、不执行参数里的命令；默认绑定 `127.0.0.1`。

## 5. 扩展点

| 想做的事 | 改哪里 | 注意 |
|---|---|---|
| 新增模型价格 | `config/pricing.json` 的 `models` / `aliases` | 价格必须非负；带 `peak` 才需要 `peakHours` |
| 新增时间档 | `time-range.mjs` 的 `TIME_RANGES` + 运行时 | 同步补 `time-range.test.mjs` 的边界用例 |
| 新增统计卡片 | `report-data.mjs` 的 summary → `report-html.mjs` 渲染 → `time-range` 前端重算 | 三处口径必须一致 |
| 改排序策略 | `activity.mjs` 的 `activityRank` / `compareActivity` | `--top N` 必须先按费用取 Top，再让运行中上浮 |
| 换页面结构 | `report-html.mjs` | 保持 `<tr data-session>`、`data-created-at`、`.wrap` 结构，实时页依赖它们 |
| 加导出按钮 | `report-html.mjs` + `time-range` 数据集 | 数据集已内嵌，可纯客户端生成 CSV |

## 6. 性能与规模

- 扫描成本与日志总字节线性相关；zstd 解压是主要开销。
- 每次刷新会重建完整报表 HTML；几十个会话时片段约 40–100 KB，刷新开销可忽略。
- 页面只替换 `.wrap`，不重载文档，因此不会闪烁或丢失滚动位置。
- 会话数达到数百时，可考虑在 `discoverSessions` 之后做 mtime 增量缓存；当前实现刻意保持无状态，
  以免缓存与「日志仍在追加」冲突。