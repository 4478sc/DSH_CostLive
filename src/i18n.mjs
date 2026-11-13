/**
 * UI strings for the live report and dashboard.
 *
 * Two locales exist: `zh` (default, Simplified Chinese) and `en`. Every string
 * the renderer emits goes through `t(locale, key, params)`; `i18nText` is the
 * pure, serializable version used by the browser runtime, which receives the
 * message table from the page itself.
 *
 * Adding a string means adding it to BOTH locales: tools/check-i18n.mjs fails
 * the build when the two key sets (or their {placeholders}) drift apart.
 */

export const LOCALES = Object.freeze(['zh', 'en']);

export const DEFAULT_LOCALE = 'zh';

export const MESSAGES = Object.freeze({
  zh: Object.freeze({
    'billing.title': "计费设置",
    'billing.mode': "计费方式",
    'billing.usage': "当前计费方式",
    'billing.real': "真实价格",
    'billing.monthly': "月订阅费用（USD/月）",
    'billing.effective': "生效日期",
    'billing.add': "添加月费记录",
    'billing.remove': "删除",
    'billing.save': "保存设置",
    'billing.saved': "已保存，正在刷新…",
    'billing.failed': "保存失败：{error}",
    'billing.hint': "Asia/Shanghai · 按自然月天数摊销，今天计整天。第一条记录可指定起算日；后续月费变更须为每月1日。不支持月中升级。0 表示未订阅；空白不是0。",
    'billing.storage': "订阅历史保存在当前后端，不改动DSH日志。宿主机SSH转发入口与虚拟机入口共用同一份设置；计费方式可在上方一键切换。",
    'billing.static': "静态快照不可保存设置；请在实时服务中修改，或使用 --billing 指定配置重新生成。",
    'billing.providers': "按提供方汇总",
    'billing.days': "按天费用（Asia/Shanghai）",
    'billing.idle': "闲置订阅费",
    'billing.note': "订阅费替换OpenCode/Codex原费用，跨来源只计一次；不向模型或会话分摊。均价含闲置费用，单位为每百万token。",
    'billing.range': "{days} 个自然日 · 截至 {until} · 闲置 {idle}",
    'billing.missing': "部分用量早于已配置的订阅生效日期，费用不完整；请补充历史记录。",
    'billing.unknown': "有 {tokens} token 缺少有效采样时间，未纳入按日统计。",
    'billing.noaverage': "—",
    'billing.history': "订阅月费历史",
    'billing.empty': "无有效日期数据",
    'billing.incomplete': "未配置",
    'app.title': 'DSH 会话费用报告',
    'app.pageTitle': 'DSH 会话费用报告 · {time}',
    'app.heading': '会话费用报告',
    'app.generated': '生成于 {time} · 数据源 {source}',
    'app.badge': '{currency} · {tokens} tokens 计价',
    'app.eyebrow': 'DeepSeek Harness · Cost Report',
    'noscript': '实时刷新需要启用 JavaScript；当前显示的是服务端生成的快照。',

    'range.label.today': '今天（{day}）',
    'range.label.7d': '最近 7 天（{from} 起）',
    'range.label.30d': '最近 30 天（{from} 起）',
    'range.label.all': '全部时间',
    'range.label.7d.span': '最近 7 天（{from} 至 {to}）',
    'range.label.30d.span': '最近 30 天（{from} 至 {to}）',
    'range.label.all.daily': '全部时间（按天）',
    'range.group': '时间范围',
    'range.flag': '已筛选',
    'range.note.all': '全部时间 · {count} 个会话',
    'range.note.range': '{label} · {kept} 个会话',
    'range.note.daily': '{label} · {sessions} 个会话 / {days} 天',
    'view.group': '统计视图',
    'view.session': '按会话',
    'view.daily': '按天',

    'card.cost': '总费用',
    'card.cost.note': '{priced} / {total} 个会话产生费用',
    'card.cost.note.daily': '{sessions} 个会话 · {days} 天（按采样）',
    'card.tokens': '总 Token',
    'card.cacheRead': '缓存读取',
    'card.cacheRead.note': '占计费输入 {percent}',
    'card.tokenPrice': 'Token均价',
    'card.tokenPrice.note': '有价 token {tokens} · 未定价不计',

    'section.models': '按模型汇总',
    'section.sessions': '会话明细（按创建时间 · 运行中优先{running} · 点击行展开模型明细）',
    'section.running': ' · 当前 {count} 个运行中',
    'section.daily': '按天费用（按采样时间切日 · 跨天会话会拆分 · 点击行展开当天会话）',
    'section.daily.hint': '按采样时间切日，同一会话跨天会拆分到两天；按天视图下 Today / 7 天 / 30 天按自然日计算（含今天），边界使用本机时区。',
    'section.price': '价格表（{currency} / {tokens} tokens）',
    'section.price.note': '未定价模型仍统计 token，但不产生金额、也不计入 Token均价（未定价 ≠ 免费）。模型 id 匹配忽略 provider 前缀与日期后缀，并支持 <code>*</code> 前缀通配。',

    'table.model': '模型',
    'table.provider': '提供方',
    'table.input': '输入',
    'table.output': '输出',
    'table.cacheWrite': '缓存写',
    'table.cacheRead': '缓存读',
    'table.cost': '费用',
    'table.tokenPrice': 'Token均价',
    'table.sessions': '会话',
    'table.tier': '档位',
    'table.source': '来源',
    'table.date': '日期',
    'table.session': '会话',
    'table.token': 'Token',
    'table.samples': '采样',
    'table.cacheHit': '缓存命中',
    'table.cacheCreate': '缓存创建',
    'table.cacheReadLong': '缓存读取',

    'empty.usage': '没有用量记录',
    'empty.sessions': '无符合条件的会话',
    'empty.daily': '无符合条件的花费',

    'more.show': '显示更多（还有 {count} 个）',
    'more.days.show': '显示更多（还有 {count} 天）',
    'more.days.plain': '显示更多',
    'more.days.less': '收起',
    'more.show.plain': '显示更多',
    'more.less': '收起',

    'pill.running': '运行中',
    'pill.subagent': '子代理',
    'pill.today': '今天',

    'detail.status': '状态',
    'detail.workspace': '工作区',
    'detail.preset': '预设',
    'detail.cacheHit': '缓存命中',
    'detail.samples': '计费采样 {count} 次',

    'day.unknown': '未知日期',
    'day.hint': '按采样时间切日 · 跨天会话只计入当天部分',

    'cost.pending': '待官网',
    'cost.share': '占比',
    'activity.runningMain': '运行中（主会话）',
    'activity.runningSub': '运行中（子代理）',
    'activity.done': '已完成',
    'activity.doneSub': '已完成（子代理）',
    'cost.unpriced': '未定价',

    'model.peak': '（峰值）',
    'model.off': '（谷值）',
    'model.offpeakTag': '· 谷值',

    'tariff.peak': '{id} 峰值时段：输入 {input} · 输出 {output} · 缓存创建 {cacheWrite} · 缓存读取 {cacheRead}（{currency} / 1M）。峰值时段 {hours}，其余时间为谷值价。',

    'tier.standard': '标准',
    'tier.long': '长档（> {tokens}）',
    'priceUsd.source.mirror': '公开页核实',
    'priceUsd.source.legacy': '沿用旧价（未核实）',
    'section.priceUsd': '美元价格表（USD / {tokens} tokens）',
    'section.priceUsd.providers': '适用提供方：{providers}（同一 Codex 服务按提供方归一，其他提供方不套用此表）。',
    'section.priceUsd.threshold': '长档判定：单条请求的输入上下文（未缓存输入 + 缓存写 + 缓存读，不含输出）超过 {tokens} tokens 时，该请求四个桶全部按长档价；否则按标准价。',
    'section.priceUsd.legacy': '以下模型沿用旧美元价、未按本次公开源重新核实：{models}。',
    'section.priceUsd.source': '来源：{label} · {url} · 更新 {retrievedAt}。公开页按「1 美元用量 = N 人民币」标价且 API 无币种字段，本表保留公开美元基准；不做换汇，也不代表登录 dashboard 的个人渠道价。本表为参考价，不是官方实付凭证。',

    'note.official': '官方用量：{sessions} 个会话的 token 与费用取自 OpenCode 控制台日志（{requests} 条请求，按 USD 计费，不折算），本地归档仅作备份。',
    'note.pending': '待官网：{count} 个会话走 opencode 官方计费但归档里还没有对应请求记录，费用不再按 CNY 价表估算；同步循环补齐后自动变成 $ 金额。',
    'note.unpriced': '未配置价格的模型：{models}。其 token 正常统计，但不产生金额、不计入均价（未定价 ≠ 免费）。',
    'note.console': '官方口径：今天 {today}（本地日）· 7 天 {seven} · 30 天 {thirty}（滚动 24 小时 ×N，与官网一致）。本页按自然日切分，7 天窗口会比官网略小。归档 {age}{stale}。',
    'note.console.stale': '——同步循环可能已停止，请在服务端执行 vm/ensure.sh（或重跑 opencode-sync --loop，日志见 logs/sync.log）',
    'note.storeAge.justNow': '刚刚同步',
    'note.storeAge.minutes': '{count} 分钟前同步',
    'note.sourceError': '数据源不可用：{sources}。请检查镜像是否已同步，或运行 dsh-cost-vm-sync.cmd。',
    'source.unavailable': '（不可用）',

    'footer.generated': '由 <code>dsh-cost</code> 生成 · 计费口径与 DSH <code>tokenUsage</code> 投影一致（同一步骤的最终样本替换流式样本，重试计为独立样本）',
    'footer.disclaimer': '费用为按公开价格估算，非账单凭证。',

    'lang.switch': 'English',
    'lang.switchLabel': '切换为英文',

    'client.live': '实时',
    'client.paused': '已暂停',
    'client.error': '连接中断',
    'client.loading': '刷新中',
    'client.autoReload': '自动重载',
    'client.static': '静态快照',
    'client.refresh': '刷新',
    'client.reload': '重载',
    'client.pause': '暂停',
    'client.resume': '继续',
    'client.openLive': '实时版',
    'client.statusAria': '实时刷新状态',
    'client.refreshTitle': '立即刷新（快捷键 R）',
    'client.pauseTitle': '暂停 / 继续自动刷新（快捷键 P）',
    'client.dataAt': '数据生成时间 {time}',
    'client.metrics': '{cost} · {sessions} 个会话\n{tokens} tokens',
    'client.allSessions': '所有会话的 token 与费用合计',
    'client.sub.paused': '自动刷新已暂停',
    'client.sub.busy': '正在拉取最新数据…',
    'client.sub.error': '连接失败 · 第 {count} 次重试中',
    'client.sub.live': '每 {seconds} 秒自动刷新 · {remaining} 秒后更新',
    'client.sub.filePaused': '文件未更新 · 自动重载已暂停',
    'client.sub.file': '每 {seconds} 秒重载 · {remaining} 秒后重载',
    'client.sub.static': '静态快照 · 不会自动更新',
    'client.note.cannotConnect': '无法连接本地服务（{error}），将自动重试。',
    'client.note.stale': '此快照连续 {count} 次没有更新：浏览器无法自行执行命令。请双击 dsh-cost-live-watch.cmd 启动后台更新，然后点「继续」。',
    'client.note.noStorage': '浏览器禁止 file:// 页面使用本地存储，自动重载已停用（否则会无限刷新）。请使用 dsh-cost-live.cmd 启动本地实时服务。',
  }),
  en: Object.freeze({
    'billing.title': "Billing settings",
    'billing.mode': "Billing mode",
    'billing.usage': "Usage pricing",
    'billing.real': "Real price",
    'billing.monthly': "Monthly subscription (USD/month)",
    'billing.effective': "Effective date",
    'billing.add': "Add price record",
    'billing.remove': "Remove",
    'billing.save': "Save settings",
    'billing.saved': "Saved. Refreshing…",
    'billing.failed': "Save failed: {error}",
    'billing.hint': "Asia/Shanghai · Natural-month daily amortization; today counts in full. The first record sets the start date; later changes must start on the first of a month. No mid-month upgrades. Enter 0 for no subscription; blank is not zero.",
    'billing.storage': "Subscription history is saved by this backend; DSH logs are never modified. The host SSH-forwarded entry and VM entry share the same settings. Switch billing modes instantly above.",
    'billing.static': "Static snapshots cannot save settings. Use the live service or regenerate with --billing.",
    'billing.providers': "Costs by provider",
    'billing.days': "Daily costs (Asia/Shanghai)",
    'billing.idle': "Idle subscription cost",
    'billing.note': "Subscription costs replace OpenCode/Codex usage prices, charged once across sources. No allocation to models or sessions. Averages include idle cost, per million tokens.",
    'billing.range': "{days} calendar days · through {until} · idle {idle}",
    'billing.missing': "Some usage predates the configured subscription start. Costs are incomplete; add the missing history.",
    'billing.unknown': "{tokens} tokens have no valid sample time and are excluded from daily accounting.",
    'billing.noaverage': "—",
    'billing.history': "Subscription price history",
    'billing.empty': "No dated usage or active subscription",
    'billing.incomplete': "Not configured",
    'app.title': 'DSH session cost report',
    'app.pageTitle': 'DSH session cost report · {time}',
    'app.heading': 'Session cost report',
    'app.generated': 'Generated {time} · sources {source}',
    'app.badge': '{currency} · priced per {tokens} tokens',
    'app.eyebrow': 'DeepSeek Harness · Cost Report',
    'noscript': 'Live refresh needs JavaScript; showing the server-rendered snapshot.',

    'range.label.today': 'Today ({day})',
    'range.label.7d': 'Last 7 days (since {from})',
    'range.label.30d': 'Last 30 days (since {from})',
    'range.label.all': 'All time',
    'range.label.7d.span': 'Last 7 days ({from} to {to})',
    'range.label.30d.span': 'Last 30 days ({from} to {to})',
    'range.label.all.daily': 'All time (by day)',
    'range.group': 'Time range',
    'range.flag': 'Filtered',
    'range.note.all': 'All time · {count} sessions',
    'range.note.range': '{label} · {kept} sessions',
    'range.note.daily': '{label} · {sessions} sessions / {days} days',
    'view.group': 'View',
    'view.session': 'By session',
    'view.daily': 'By day',

    'card.cost': 'Total cost',
    'card.cost.note': '{priced} of {total} sessions with cost',
    'card.cost.note.daily': '{sessions} sessions · {days} days (by sample)',
    'card.tokens': 'Total tokens',
    'card.cacheRead': 'Cache read',
    'card.cacheRead.note': '{percent} of billed input',
    'card.tokenPrice': 'Price per 1M tokens',
    'card.tokenPrice.note': 'priced tokens {tokens} · unpriced excluded',

    'section.models': 'Per model',
    'section.sessions': 'Session detail (by creation time · running first{running} · click a row to expand its models)',
    'section.running': ' · {count} running now',
    'section.daily': 'Daily cost (by sample time · midnight-crossing sessions split · click a row to expand that day)',
    'section.daily.hint': 'Samples are bucketed by their own timestamp, so one session can appear on two days; in the by-day view Today / 7 days / 30 days are calendar days (including today) in the local time zone.',
    'section.price': 'Price table ({currency} / {tokens} tokens)',
    'section.price.note': 'Unpriced models still contribute tokens but produce no amount and are excluded from the price average (unpriced != free). Model ids ignore the provider prefix and any date suffix, and support <code>*</code> prefix matching.',

    'table.model': 'Model',
    'table.provider': 'Provider',
    'table.input': 'Input',
    'table.output': 'Output',
    'table.cacheWrite': 'Cache write',
    'table.cacheRead': 'Cache read',
    'table.cost': 'Cost',
    'table.tokenPrice': 'Price / 1M',
    'table.sessions': 'Sessions',
    'table.tier': 'Tier',
    'table.source': 'Source',
    'table.date': 'Date',
    'table.session': 'Session',
    'table.token': 'Tokens',
    'table.samples': 'Samples',
    'table.cacheHit': 'Cache hit',
    'table.cacheCreate': 'Cache create',
    'table.cacheReadLong': 'Cache read',

    'empty.usage': 'No usage records',
    'empty.sessions': 'No sessions in range',
    'empty.daily': 'No cost in range',

    'more.show': 'Show more ({count} left)',
    'more.days.show': 'Show more ({count} more days)',
    'more.days.plain': 'Show more',
    'more.days.less': 'Show less',
    'more.show.plain': 'Show more',
    'more.less': 'Show less',

    'pill.running': 'running',
    'pill.subagent': 'subagent',
    'pill.today': 'today',

    'detail.status': 'Status',
    'detail.workspace': 'Workspace',
    'detail.preset': 'Preset',
    'detail.cacheHit': 'Cache hit',
    'detail.samples': '{count} billed samples',

    'day.unknown': 'Unknown date',
    'day.hint': 'bucketed by sample time · midnight-crossing sessions count only that day',

    'cost.pending': 'pending console',
    'cost.share': 'Share',
    'activity.runningMain': 'running (main)',
    'activity.runningSub': 'running (subagent)',
    'activity.done': 'completed',
    'activity.doneSub': 'completed (subagent)',
    'cost.unpriced': 'unpriced',

    'model.peak': ' (peak)',
    'model.off': ' (off-peak)',
    'model.offpeakTag': '· off-peak',

    'tariff.peak': '{id} peak: input {input} · output {output} · cache create {cacheWrite} · cache read {cacheRead} ({currency} / 1M). Peak hours {hours}; all other hours use the off-peak rates.',

    'tier.standard': 'Standard',
    'tier.long': 'Long (> {tokens})',
    'priceUsd.source.mirror': 'mirror-verified',
    'priceUsd.source.legacy': 'legacy (not re-verified)',
    'section.priceUsd': 'USD price table (USD / {tokens} tokens)',
    'section.priceUsd.providers': 'Applies to {providers} (the same Codex service, folded by provider); other providers never use this table.',
    'section.priceUsd.threshold': 'Long-context tier: when the input context of one request (uncached input + cache write + cache read, excluding output) exceeds {tokens} tokens, all four buckets of that request use the long rates; otherwise the standard rates apply.',
    'section.priceUsd.legacy': 'These models keep their previous USD rates and were not re-verified against the public source in this update: {models}.',
    'section.priceUsd.source': 'Source: {label} · {url} · updated {retrievedAt}. The public page quotes 1 USD of usage at a fixed RMB rate and the API carries no currency field, so this table keeps the public USD base rates; nothing is converted, and this is not a logged-in dashboard channel price. This table is a reference price, not an official invoice.',

    'note.official': 'Official usage: tokens and cost for {sessions} sessions come from the OpenCode console log ({requests} requests, billed in USD, never converted); the local archive is a backup only.',
    'note.pending': 'Pending console: {count} sessions are billed by opencode but have no archived request yet, so their cost is not estimated from the CNY table — it turns into a USD amount once the sync catches up.',
    'note.unpriced': 'Models without a price: {models}. Their tokens are counted but they produce no amount and are excluded from the price average (unpriced != free).',
    'note.console': 'Official console: today {today} (local day) · 7 days {seven} · 30 days {thirty} (rolling 24 h × N, matching the console). This page splits by calendar day, so the 7-day window is slightly smaller than the console\'s. Archive synced {age}{stale}.',
    'note.console.stale': ' — the sync loop may have stopped; run vm/ensure.sh on the server (or restart opencode-sync --loop, see logs/sync.log)',
    'note.storeAge.justNow': 'just now',
    'note.storeAge.minutes': '{count} minutes ago',
    'note.sourceError': 'Source unavailable: {sources}. Check whether the mirror is synced, or run dsh-cost-vm-sync.cmd.',
    'source.unavailable': ' (unavailable)',

    'footer.generated': 'Generated by <code>dsh-cost</code> · billing follows the DSH <code>tokenUsage</code> projection (a later sample replaces the streamed one; a retry is billed separately)',
    'footer.disclaimer': 'Costs are estimates from published list prices, not an invoice.',

    'lang.switch': '中文',
    'lang.switchLabel': 'Switch to Chinese',

    'client.live': 'live',
    'client.paused': 'paused',
    'client.error': 'disconnected',
    'client.loading': 'refreshing',
    'client.autoReload': 'auto reload',
    'client.static': 'static snapshot',
    'client.refresh': 'Refresh',
    'client.reload': 'Reload',
    'client.pause': 'Pause',
    'client.resume': 'Resume',
    'client.openLive': 'live version',
    'client.statusAria': 'Live refresh status',
    'client.refreshTitle': 'Refresh now (shortcut R)',
    'client.pauseTitle': 'Pause / resume auto refresh (shortcut P)',
    'client.dataAt': 'Data generated {time}',
    'client.metrics': '{cost} · {sessions} sessions\n{tokens} tokens',
    'client.allSessions': 'tokens and cost across all sessions',
    'client.sub.paused': 'Auto refresh is paused',
    'client.sub.busy': 'Fetching the latest data…',
    'client.sub.error': 'Connection failed · retry {count}',
    'client.sub.live': 'Auto refresh every {seconds}s · next update in {remaining}s',
    'client.sub.filePaused': 'File not updated · auto reload paused',
    'client.sub.file': 'Reload every {seconds}s · next reload in {remaining}s',
    'client.sub.static': 'Static snapshot · does not update by itself',
    'client.note.cannotConnect': 'Cannot reach the local server ({error}); retrying automatically.',
    'client.note.stale': 'This snapshot has not changed {count} times: a browser cannot run commands. Double-click dsh-cost-live-watch.cmd to start the background rebuild, then press Resume.',
    'client.note.noStorage': 'The browser blocks local storage on file:// pages, so auto reload is disabled (it would loop forever). Start the local server with dsh-cost-live.cmd.',
  }),
});

/** Normalize a locale tag ("en-US", "zh_CN", "EN") to a supported locale. */
export function normalizeLocale(value) {
  if (typeof value !== 'string') return DEFAULT_LOCALE;
  const tag = value.trim().toLowerCase();
  if (tag === '') return DEFAULT_LOCALE;
  if (tag === 'en' || tag.startsWith('en-') || tag.startsWith('en_')) return 'en';
  if (tag === 'zh' || tag.startsWith('zh-') || tag.startsWith('zh_')) return 'zh';
  return DEFAULT_LOCALE;
}

/** Pick a locale from an Accept-Language header, e.g. "en-US,en;q=0.9,zh;q=0.8". */
export function localeFromAcceptLanguage(header) {
  if (typeof header !== 'string' || header.trim() === '') return DEFAULT_LOCALE;
  const parts = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q.slice(2)) };
    })
    .filter((part) => part.tag !== '' && !Number.isNaN(part.q))
    .sort((a, b) => b.q - a.q);
  for (const part of parts) {
    const locale = normalizeLocale(part.tag);
    if (locale !== DEFAULT_LOCALE || part.tag.toLowerCase().startsWith('zh')) return locale;
  }
  return DEFAULT_LOCALE;
}

/**
 * Pure formatter used by both the renderer and the serialized browser runtime.
 * Missing keys fall back to the key itself so a gap is obvious, never silent.
 */
export function i18nText(messages, key, params) {
  const table = messages !== null && typeof messages === 'object' ? messages : {};
  const raw = table[key];
  const value = typeof raw === 'string' ? raw : key;
  if (params === null || params === undefined) return value;
  return value.replace(/\{(\w+)\}/g, (match, name) =>
    params[name] === null || params[name] === undefined ? match : String(params[name]),
  );
}

/** Known data-source labels rendered in English (the config itself stays as-is). */
const SOURCE_LABELS_EN = Object.freeze({
  '主机': 'host',
  '本机': 'local',
  '虚拟机': 'VM',
  '云主机': 'cloud',
});

/** Localize a configured source label for display; unknown labels pass through. */
export function sourceLabel(label, locale) {
  if (normalizeLocale(locale) !== 'en' || typeof label !== 'string') return label;
  return SOURCE_LABELS_EN[label.trim()] ?? label;
}

/** Server-side shorthand: t('en', 'card.cost'). */
export function t(locale, key, params) {
  const normalized = normalizeLocale(locale);
  return i18nText(MESSAGES[normalized] ?? MESSAGES[DEFAULT_LOCALE], key, params);
}
