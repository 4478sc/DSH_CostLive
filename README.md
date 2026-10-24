# DSH_CostLive

> 给 DeepSeek Harness（DSH）会话做的**本地费用实时面板**：
> 每 20 秒重新扫描会话日志，按模型、按 token 桶（未缓存输入 / 输出 / 缓存写 / 缓存读）计价，
> 在浏览器里显示人民币花费、缓存命中、运行中会话与历史明细。

[![Node](https://img.shields.io/badge/node-%E2%89%A522.15-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![tests](https://github.com/4478sc/DSH_CostLive/actions/workflows/test.yml/badge.svg)](https://github.com/4478sc/DSH_CostLive/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dependencies](https://img.shields.io/badge/dependencies-0-success)](#项目结构)

![实时费用面板（演示数据）](assets/preview.png)

截图由仓库自带的合成数据生成（`tools/make-demo-home.mjs`），不含任何真实会话内容。

---

## 这是什么

DSH 会把每个会话的完整事件流写进 `~/.dsh/sessions/` 下的 zstd 日志，但界面只显示 token 总量，
不显示金额，也没有跨会话汇总。本项目补上这一块：

- **零依赖**：只用 Node.js 标准库（`node:zlib` 的 zstd、`node:http`），没有 `npm install` 步骤。
- **只读**：只读取会话日志与投影缓存，不写入 DSH 数据，不改配置。
- **本地**：默认只监听 `127.0.0.1`，页面无鉴权，也不会把数据发到任何外部服务。
- **可核对**：`--verify` 能与 DSH 自己的 `tokenUsage` 投影逐会话对账；计价按事件重算，
  同一步骤的流式样本会被最终样本替换，重试算独立计费样本。

它同时包含一个命令行工具（`dsh-cost`）和一个本地网页（`dsh-cost-live`），网页复用报告的同一套
采集 / 计价 / 渲染代码，所以页面数字与 CLI 完全一致。

---

## 功能

| 能力 | 说明 |
|---|---|
| 20 秒实时刷新 | 浏览器轮询 `/api/fragment`，只替换报表主体，滚动位置与展开行不丢 |
| 四档时间范围 | `All time` / `Last 30 days` / `Last 7 days` / `Today`，卡片、模型表、明细同步重算，选择持久化 |
| 运行中优先 | 运行中主会话 → 运行中子代理 → 已完成（费用降序）；运行中行高亮 + 脉冲标签 |
| 前 5 行折叠 | 首屏只显示 5 条，其余「显示更多（还有 N 个）」，展开状态在刷新与筛选间保持 |
| 分模型汇总 | 每个 provider/model 的四桶 token、费用、占比、会话数；未定价模型单独标注 |
| 峰谷两档价 | `deepseek-v4.1-flash` 按**每条采样自己的时间戳**判定工作日峰时/谷时，跨时段会话分段计价 |
| 缓存指标 | 缓存命中率、缓存读取量、按「输入价 − 缓存读价」估算的缓存节省 |
| 三种模式 | 本地 HTTP 服务（推荐）、`file:///` + 后台重建、一次性静态快照 |
| 只读 API | `/api/fragment`、`/api/report`、`/api/health`，方便脚本或其他面板复用 |
| 报告导出 | HTML / JSON / CSV；终端表格视图；单会话按轮次、按步骤明细 |

---

## 快速开始

要求 **Node.js ≥ 22.15**（需要 `node:zlib` 的 zstd 支持）。无需安装依赖。

```powershell
git clone https://github.com/4478sc/DSH_CostLive.git
cd DSH_CostLive

# 1) 想先看效果：生成 10 个虚构会话（写进 demo-home/，可随时删除）
node tools/make-demo-home.mjs
node bin/dsh-cost-live.mjs --home demo-home

# 2) 看自己的真实数据：默认读 $DSH_HOME，其次 ~/.dsh
node bin/dsh-cost-live.mjs
```

浏览器打开控制台打印的地址（默认 <http://127.0.0.1:4173/>），`Ctrl+C` 停止。

Windows 上也可以直接双击：

| 文件 | 作用 |
|---|---|
| `dsh-cost-live.cmd` | 本地 HTTP 服务（推荐，页面原地刷新） |
| `dsh-cost-live-watch.cmd` | 后台每 20 秒重建独立 HTML，供 `file:///` 打开 |

> macOS / Linux：命令相同，`.cmd` 换成 `node bin/dsh-cost-live.mjs` 即可。

---

## 三种运行模式

| 模式 | 命令 | 行为 | 适合 |
|---|---|---|---|
| **本地 HTTP 服务（推荐）** | `node bin/dsh-cost-live.mjs` | 页面每 20 秒拉 `/api/fragment` 原地更新，不丢滚动/展开状态 | 长期开着看 |
| **file:/// + 后台重建** | `node bin/dsh-cost-live.mjs --watch` | 每 20 秒原子重写 `out/dsh-cost-live.html`，页面自动重载 | 只能/只想用 `file:///` |
| **一次性快照** | `node bin/dsh-cost-live.mjs --once --out out/snapshot.html` | 生成一份静态页面后退出 | 归档、发给别人 |

常用参数：

```powershell
node bin/dsh-cost-live.mjs --port 8080 --interval 10      # 换端口、10 秒刷新
node bin/dsh-cost-live.mjs --model deepseek --no-open     # 只看 DeepSeek 会话
node bin/dsh-cost-live.mjs --top 10 --all                 # 费用最高的 10 个（含无用量会话）
node bin/dsh-cost-live.mjs --host 0.0.0.0                 # 局域网访问（无鉴权，谨慎）
```

端口被占用会自动 +1；`--interval` 最小 5 秒。完整选项见 [`LIVE.md`](LIVE.md#命令行选项)。

---

## 页面怎么用

- **时间范围**：顶部四档按钮。切档时重算四张卡片与模型汇总，并对**筛选后的**明细重新分页；
  缺少 `createdAt` 的历史会话永不隐藏（宁可多显示，不能藏真实花费）。
- **会话明细**：默认 5 条。点击任意行展开该会话的模型明细、按轮次小计与每个计费采样。
- **右下角浮窗**：连接状态、数据生成时间、下次刷新倒计时、总费用 / 会话数 / 总 Token；
  按钮「刷新 / 暂停」，快捷键 **R** 刷新、**P** 暂停。标签页在后台时倒计时暂停。
- **状态含义**：绿色「实时」、灰色「已暂停」、红色「连接中断」、琥珀色「快照未更新」。
- 浏览器宽度 ≤ 820px 时隐藏时间范围条；≤ 640px 时浮窗改为通栏。

---

## 数据与计价

### 数据来源

```text
~/.dsh/sessions/<编码后的工作区>/<session-id>/session.v4.jsonl.zstd
        │  多 frame zstd（每次追加一帧）→ 逐帧解压 → JSONL 事件流
        ▼
session 头 / session/title / request.header / assistant.message / llm.retry-started ...
        │  fold：同一步骤后到的样本替换流式样本，重试独立计费
        ▼
四桶用量 + 逐样本 provider/model/time → 按模型价表计价（micro-CNY 取整）
```

- DSH 数据目录优先级：`--home` → `$DSH_HOME` → `~/.dsh`。
- 子代理是独立会话（独立日志、独立计价），面板会打「子代理」标签并排在主会话之后。
- 投影缓存 `~/.dsh/storages/session_projcache/sessions/<id>.json` 只用于运行状态、标题与
  `--verify` 对账；金额始终由日志重算。

### 价格表

默认价表在 [`config/pricing.json`](config/pricing.json)，单位 **CNY / 1,000,000 tokens**：

| 模型 | 输入（未缓存） | 输出 | 缓存写 | 缓存读 |
|---|---:|---:|---:|---:|
| `claude-sonnet-5-5` | 2.3 | 11.5 | 2.875 | 0.23 |
| `deepseek-v4.1-flash`（谷值） | 0.15 | 0.6 | 0.15 | 0.003 |
| `deepseek-v4.1-flash`（峰值） | 0.3 | 1.2 | 0.3 | 0.006 |

```text
cost = (未缓存输入 × input + 输出 × output + 缓存写 × cacheWrite + 缓存读 × cacheRead) / 1e6
```

- 两档价按**每条采样自己的时间戳**选档，跨峰谷的会话两段分别计价；没有时间戳按谷值（不会虚高）。
- 默认峰时：`Asia/Shanghai` 周一至周五 `[09:00,12:00)`、`[14:00,18:00)`（左闭右开），
  周末与 `peakHours.holidays` 中的日期按谷值。
- `cacheWrite` 价对 DeepSeek 等于 `input`（若上报缓存写，按未命中输入计）；但 `deepseek-v4.1-flash`
  等模型**没有缓存写**，`cacheWriteTokens` 恒为 0，该项价格乘 0，**不会与 `input` 重复计入总价**。
- 未定价模型仍统计 token，费用记 0，并在页面顶部与 JSON 的 `unpricedModels` 中列出。
- 费用是**按配置单价的估算**，不含批处理折扣、阶梯价、退款，不是账单凭证。

自定义价表：编辑 `config/pricing.json`，或 `--pricing my-pricing.json`。模型匹配依次为
精确 id → 去 provider 前缀 → 去日期后缀 → 别名 → `*` 最长前缀通配。加模型只需在 `models`
里加条目，无需改代码。

---

## API

服务模式提供三个只读接口：

| 路径 | 内容 |
|---|---|
| `GET /api/fragment` | 最新报表 HTML 片段 + `generatedAt` / `summary` / `intervalMs` / `stale` |
| `GET /api/report` | 与 `dsh-cost report --format json` 相同的完整 JSON |
| `GET /api/health` | 存活状态、扫描次数、耗时、最近错误、当前汇总 |

```powershell
Invoke-RestMethod http://127.0.0.1:4173/api/health | Format-List
(Invoke-RestMethod http://127.0.0.1:4173/api/report).summary
```

---

## 命令行（同一套内核）

```powershell
node bin/dsh-cost.mjs                              # 会话总览
node bin/dsh-cost.mjs models                       # 打印价表（含峰时与别名）
node bin/dsh-cost.mjs session <id|前缀> --steps    # 单会话明细
node bin/dsh-cost.mjs --model deepseek             # 按模型过滤
node bin/dsh-cost.mjs --since 2026-10-01 --priced-only
node bin/dsh-cost.mjs report --format html --out out/report.html
node bin/dsh-cost.mjs report --format csv  --out out/report.csv
node bin/dsh-cost.mjs --json                       # 机器可读
node bin/dsh-cost.mjs --verify                     # 与 DSH tokenUsage 投影对账
```

| 选项 | 说明 |
|---|---|
| `--home <dir>` / `--pricing <file>` | 数据目录 / 自定义价表 |
| `--workspace <text>` / `--model <text>` | 按工作区目录名 / 模型子串过滤 |
| `--since` / `--until` | 会话创建时间范围（`YYYY-MM-DD` 或 ISO） |
| `--top <n>` / `--priced-only` / `--all` | 费用 Top N / 仅计费会话 / 含无用量会话 |
| `--format table\|json\|csv\|html` / `--out` | 输出格式与文件 |
| `--verify` / `--verbose` | 投影校验 / stderr 警告 |

退出码：`0` 成功，`1` 无数据或运行失败，`2` 参数错误。

---

## 项目结构

```text
DSH_CostLive/
├─ bin/
│  ├─ dsh-cost.mjs            # CLI 入口
│  └─ dsh-cost-live.mjs       # 实时面板入口（server / --watch / --once）
├─ config/pricing.json        # 价表（谷/峰/别名）
├─ src/
│  ├─ pricing.mjs             # 价表归一、模型匹配、峰谷判定、micro-CNY 计价
│  ├─ engine.mjs              # 事件流 fold → 计费采样与四桶聚合
│  ├─ sessions.mjs            # 会话发现、日志读取、投影缓存
│  ├─ zstd.mjs                # 多 frame zstd 解压（Node 只解第一帧）
│  ├─ activity.mjs            # 运行中/子代理判定与排序
│  ├─ time-range.mjs          # 四档筛选 + 浏览器运行时源码（Node 与页面共用）
│  ├─ report-data.mjs         # 会话记录、数据集、CSV、聚合
│  ├─ report-text.mjs         # 终端表格 / 明细 / 价格表
│  ├─ report-html.mjs         # 自包含 HTML 报告（CSS/JS 内联）
│  ├─ live.mjs                # 实时页文档 / 片段 / 原子写入
│  ├─ live-server.mjs         # 本地 HTTP 服务与三个 API
│  └─ live-client.js          # 浏览器端：轮询、折叠、范围、滚动恢复
├─ test/                      # node:test，7 个文件 54 项
├─ tools/make-demo-home.mjs   # 合成演示数据生成器
├─ docs/                      # 架构、DSH token 口径调研、开发笔记
├─ assets/preview.png         # 截图（演示数据）
├─ LIVE.md                    # 实时面板完整使用说明
├─ dsh-cost-live.cmd          # Windows 启动器：HTTP 服务
└─ dsh-cost-live-watch.cmd    # Windows 启动器：后台重建 HTML
```

没有运行时依赖，所以没有 `package-lock.json` / `node_modules`。

---

## 测试

```powershell
npm test
```

| 文件 | 项数 | 覆盖 |
|---|---:|---|
| `pricing.test.mjs` | 11 | 价格归一、别名、通配、峰谷判定、micro-CNY 精度、内置表一致性 |
| `engine.test.mjs` | 8 | 流式样本替换、重试、四桶归并、零用量、模型切换 |
| `activity.test.mjs` | 7 | `openStep` 权威性、`turnBoundary` 回退、子代理双通道识别、三桶稳定排序 |
| `time-range.test.mjs` | 18 | 四档边界、缺失日期、聚合算术、浏览器运行时、DOM 事件、存储容错、HTML 集成 |
| `live.test.mjs` | 6 | 采集/过滤、模板拆分、原子写入、HTTP API |
| `sessions.test.mjs` | 2 | 会话发现与读取 |
| `zstd.test.mjs` | 2 | 多 frame 解压、非压缩 JSONL 兜底 |
| **合计** | **54** | |

CI 会在 Node 22 与 Node 24 上跑同一套测试（`.github/workflows/test.yml`）。
Node 22 的测试进程隔离开关仍叫 `--experimental-test-isolation`，所以那边执行 `npm run test:node22`。

---

## 开发与维护

- 改价格：只动 `config/pricing.json`；改峰时窗口同理，改完跑 `npm test`。
- 加时间档 / 改边界语义：只改 `src/time-range.mjs`，Node 测试与浏览器共用同一份源码，
  不会出现「服务端一套、前端另一套」。
- 改页面样式：`src/report-html.mjs`（报告）与 `src/live.mjs` 里的 `LIVE_CSS` / `live-client.js`（浮窗）。
- 两条硬约束：**先筛选、后分页**；**逐采样判峰谷**。
- 更细的模块职责、数据流与扩展点见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；
  DSH token 统计口径见 [`docs/DSH-TOKEN-ACCOUNTING.md`](docs/DSH-TOKEN-ACCOUNTING.md)；
  踩坑记录与调试命令见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)。

---

## 隐私与安全

- 只读本地文件；服务默认绑定 `127.0.0.1`，只提供页面与 JSON，不执行请求里的命令。
- 页面会显示会话标题与工作区路径。使用 `--host 0.0.0.0` 时页面**没有鉴权**，仅限可信网络。
- `demo-home/` 与 `out/` 都是生成物，已在 `.gitignore` 中；不要把真实会话日志或报告提交到仓库。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 双击后窗口一闪而过 / 提示 Node not found | 安装 Node.js ≥ 22.15，确认 `node -v` 可用 |
| 页面「连接中断」 | 服务已停止；重新启动，再刷新页面 |
| 页面「已暂停 / 快照未更新」 | 后台重建任务没在跑；启动 `dsh-cost-live-watch.cmd` 或在浮窗点「继续」 |
| 0 个会话 | 检查 `--home` / `$DSH_HOME` / `~/.dsh/sessions` 是否有 `session.v4.jsonl.zstd` |
| 金额和 DSH 对不上 | 运行 `node bin/dsh-cost.mjs --verify`；运行中的会话投影可能滞后，稍后重跑 |
| 峰时价格没生效 | 用 `--since` 检查采样时间是否落在工作日峰时窗口；12:00 / 18:00 整已是谷值 |

更多排障见 [`LIVE.md#故障排查`](LIVE.md#故障排查)。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [`LIVE.md`](LIVE.md) | 实时面板：三种模式、页面行为、API、全部参数、排障、安全 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 数据流、模块职责、关键不变量、扩展点 |
| [`docs/DSH-TOKEN-ACCOUNTING.md`](docs/DSH-TOKEN-ACCOUNTING.md) | DSH 如何统计 token（事件、投影、替换/重试规则） |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 开发笔记：坑位、调试命令、验收清单、后续想法 |

---

## License

[MIT](LICENSE) © 2026 4478sc