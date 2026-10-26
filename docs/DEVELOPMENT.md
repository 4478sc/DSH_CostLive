# 开发笔记

接手时需要知道的环境细节、常见坑、调试命令与验收清单。

## 1. 环境

- Node.js **≥ 22.15**（`node:zlib` 提供 zstd）；开发时用过 Node 24。
- 无第三方依赖，不需要 `npm install`。
- 测试使用内置 `node:test`，必须带 `--test-isolation=none`（`npm test` 已包含）：
  多个测试文件共享同一进程，`time-range` 的浏览器域运行时依赖这一点。
  在 Node 22 上该开关叫 `--experimental-test-isolation=none`，用 `npm run test:node22`。

```powershell
npm test
node --test --test-isolation=none test/activity.test.mjs   # 单文件定位
```

## 2. 改代码的推荐顺序

1. 先写/改测试（`test/*.test.mjs`），确认失败原因是预期的那条。
2. 改 `src/` 里的唯一实现，不要在 `report-html.mjs` / `live-client.js` 里复制规则。
3. `npm test` 全绿。
4. 用真实数据跑一遍页面：`node bin/dsh-cost-live.mjs`，重点看范围切换、折叠、浮窗状态。
5. 需要截图/演示时用 `node tools/make-demo-home.mjs`，不要提交真实会话数据。

## 3. 已知坑

### 3.1 终端中文乱码 ≠ 文件损坏

Windows PowerShell 用默认编码 `Get-Content` 读 UTF-8 源文件时会出现 `鏈細璇濊垂鐢` 之类乱码。
这是终端解码问题。用编辑器或支持 UTF-8 的读取方式核对，**不要因此重写文件**。

### 3.2 PowerShell 重定向会写成 UTF-16

```powershell
node bin/dsh-cost.mjs --json > out/x.json   # 可能是 UTF-16，JSON.parse 失败
```

稳妥做法：在 Node 里直接调用模块，或 `[IO.File]::WriteAllText(path, text, [Text.UTF8Encoding]::new($false))`。

### 3.3 `file:///` 页面不能用本地存储

浏览器禁止 `file:///` 页面使用 `sessionStorage` / `localStorage`（部分浏览器/配置）。
`live-client.js` 会探测并降级：禁用自动重载并显示提示，而不是无限刷新。
需要完整功能就用 HTTP 服务模式。

### 3.4 价格改动必须两边一致（曾经的插件）

本仓库只有 CLI + 网页，价表只有 `config/pricing.json` 一份。早期曾有一个独立 GUI 插件内置了
同一份价表，升级时容易漏同步；该插件已不在本仓库内。若将来重新引入，务必让插件从 JSON 读，
或在测试里断言两边一致。

### 3.5 非法峰时窗口不会报错

`peakHours.windows` 里的非法字符串会被解析成 `{start:0,end:0}`，不会崩，但永远不会命中。
改完价格表跑一次 `pricing.test.mjs`，或用一行命令验证：

```powershell
node -e "import('./src/pricing.mjs').then(p=>{const t=p.loadPricing();const d=t.models['deepseek-v4.1-flash'];for(const s of ['2026-10-26T10:30:00+08:00','2026-10-26T13:00:00+08:00','2026-10-24T10:30:00+08:00'])console.log(s,p.isPeak(d,Date.parse(s)))})"
# 期望 true / false / false（周六不算峰时）
```

### 3.6 `time-range` 里不要直接 `Date.now()`

`sessionMatchesRange` / `aggregateRangeStats` 都接收显式 `now`。测试用固定时间戳覆盖边界，
实现里硬编码 `Date.now()` 会让测试变成偶发失败。

### 3.7 历史投影可能显示 ¥0

`tokenCost` 这类投影是增量 fold 并持久化的，旧状态不会因代码更新自动重算。
网页面板与 CLI 从日志重算，不受影响；如果你在别处读投影发现 `priced:false`，先确认是不是历史缓存。

### 3.8 会话仍在写入时数字会变

日志在追加，20 秒后自然更新。`--verify` 对运行中会话出现不一致属正常滞后。

## 4. 调试命令

```powershell
# 单会话每个计费采样（定位某次为何贵）
node bin/dsh-cost.mjs session <id|前缀> --steps

# 与 DSH tokenUsage 投影对账
node bin/dsh-cost.mjs --verify

# 价格表（谷值 / 峰值 / 别名）
node bin/dsh-cost.mjs models

# 实时服务健康检查
Invoke-RestMethod http://127.0.0.1:4173/api/health | Format-List

# 生成一份静态报告，检查内嵌数据
node bin/dsh-cost.mjs report --format html --out out/report.html
```

定位顺序：价格问题 → `models` + `isPeak`；用量问题 → `--verify` + `--steps`；
展示问题 → 生成 HTML 里的 `dsh-cost-data` JSON 与 `DSH_TIME_RANGE` 运行时。

## 5. 验收清单

- [ ] `npm test` → 61 pass / 0 fail
- [ ] `node bin/dsh-cost.mjs models` 同时显示谷值表、峰值表、别名
- [ ] 总览首屏运行中会话在最前（若有）
- [ ] 报告/面板默认 5 条，按钮文案「显示更多（还有 N 个）」
- [ ] 四档范围切换后卡片金额、模型表、列表同步变化，刷新后选择保留
- [ ] 「按会话 / 按天」切换后：按天视图跨午夜会话拆成两天，日桶之和等于总费用
- [ ] `?view=daily&range=today` 能直接打开按天视图（URL 参数优先于本地存储）
- [ ] 实时页 20 秒后原地更新，滚动与展开行不丢
- [ ] `--host 0.0.0.0` 时才可从其他设备访问（默认仅本机）
- [ ] 没有把 `out/`、`demo-home/` 或真实日志提交进仓库

## 6. 性能观察

- 一次完整扫描（约 10–20 个会话）约 100–300 ms；zstd 解压占主要时间。
- 页面片段约 40–100 KB；浏览器只替换 `.wrap`，刷新无闪烁。
- 服务端会把 1 秒内的重复请求合并为一次扫描，多标签页不会放大磁盘压力。

## 7. 后续可做

| 优先级 | 想法 | 说明 |
|---|---|---|
| P1 | 自定义日期范围 | 在四档之上加日期选择器，复用 `sessionMatchesRange` 的区间语义 |
| P1 | 导出 CSV / JSON 按钮 | 数据集已内嵌，纯客户端生成即可 |
| P1 | 费用预警 | 单会话/单日阈值提醒；比限制 agent token 策略安全得多 |
| P2 | 按子代理分组 | 数据已带 `isSubagent` / `identity`，可做父子会话费用树 |
| P2 | 趋势图 | 按天/小时聚合，注意时区与峰谷窗口叠加 |
| P2 | 缓存优化提示 | 用 `cacheHit` 与 cacheWrite/Read 比例给建议，标注为启发式 |

> 历史教训：不要试图给模型注入 token 上限来控制花费——它与 DSH 的会话/压缩模型冲突，
> 曾导致启动崩溃。控费请做「预警/预算提示」。