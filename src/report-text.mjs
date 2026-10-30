/** Human-readable terminal reports. */
import { activityLabel } from './activity.mjs';
import { billedInputTokens, describePeakHours, formatCny, formatTokens } from './pricing.mjs';
import { formatPercent, formatTime, renderTable, truncateDisplay } from './format.mjs';

const alignList = ['l', 'l', 'l', 'l', 'r', 'r', 'r', 'r', 'r'];

/** One model label for compact rows: "claude-sonnet-5-5" or "claude-sonnet-5-5 +2". */
function modelsLabel(analysis) {
  const names = analysis.byModel.map((entry) => entry.model ?? 'unknown');
  if (names.length === 0) return '—';
  if (names.length === 1) return names[0];
  return `${names[0]} +${names.length - 1}`;
}

/** Summary table over analyzed sessions. */
export function renderList(results, { pricing, home, sources = [], generatedAt }) {
  const lines = [];
  const priced = results.filter((result) => result.analysis.totals.costMicroCny > 0);
  const multiSource = Array.isArray(sources) && sources.length > 1;
  lines.push(`DSH 会话费用  ·  ${pricing.currency}  ·  ${pricing.unitTokens.toLocaleString('en-US')} tokens 计价`);
  if (multiSource) {
    lines.push(`数据源  ${sources.map((source) => `${source.label}: ${source.home}${source.error ? '（不可用）' : ''}`).join(' · ')}`);
  } else {
    lines.push(`数据目录  ${home}`);
  }
  lines.push(`会话 ${results.length} 个  ·  产生费用 ${priced.length} 个  ·  ${formatTime(generatedAt)}`);
  if (results.length === 0) {
    lines.push('', '没有找到会话日志。');
    return lines.join('\n');
  }

  const rows = results.map((result) => {
    const { meta, analysis } = result;
    const unpricedMark = analysis.unpricedModels.length > 0 ? ' *' : '';
    const costCell = analysis.totals.costMicroCny > 0 ? formatCny(analysis.totals.costCny) : '—';
    // Running rows are already sorted first; the marker explains why a cheaper
    // session can appear above an expensive completed one.
    const runningMark = meta.running === true ? (meta.isSubagent === true ? '●子 ' : '● ') : '';
    return [
      truncateDisplay(meta.id, 16),
      `${runningMark}${formatTime(meta.createdAt).slice(0, 10)}`,
      truncateDisplay(`${multiSource && meta.source ? `[${meta.source}] ` : ''}${meta.title ?? '(untitled)'}`, 18),
      truncateDisplay(modelsLabel(analysis), 16),
      formatTokens(analysis.totals.tokens.uncachedInputTokens),
      formatTokens(analysis.totals.tokens.outputTokens),
      formatTokens(analysis.totals.tokens.cacheWriteTokens),
      formatTokens(analysis.totals.tokens.cacheReadTokens),
      `${costCell}${unpricedMark}`,
    ];
  });
  lines.push('');
  lines.push(
    renderTable(
      ['ID', 'DATE', 'TITLE', 'MODELS', 'INPUT', 'OUTPUT', 'CACHE-W', 'CACHE-R', 'COST'],
      rows,
      alignList,
      [14, 14, 14, 16, 10, 10, 10, 10, 11],
    ),
  );

  const runningCount = results.filter((result) => result.meta.running === true).length;
  if (runningCount > 0) {
    lines.push('');
    lines.push(`运行中 ${runningCount} 个已置顶（● 主会话 · ●子 子代理）`);
  }

  const totals = results.reduce(
    (acc, result) => {
      const buckets = result.analysis.totals.tokens;
      acc.input += buckets.uncachedInputTokens;
      acc.output += buckets.outputTokens;
      acc.cacheWrite += buckets.cacheWriteTokens;
      acc.cacheRead += buckets.cacheReadTokens;
      acc.cost += result.analysis.totals.costCny;
      return acc;
    },
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
  );
  lines.push('');
  lines.push(
    `合计  in ${formatTokens(totals.input)}  ·  out ${formatTokens(totals.output)}  ·  cacheW ${formatTokens(totals.cacheWrite)}  ·  cacheR ${formatTokens(totals.cacheRead)}  ·  ${formatCny(totals.cost)}`,
  );
  const unpriced = [...new Set(results.flatMap((result) => result.analysis.unpricedModels))];
  if (unpriced.length > 0) lines.push(`* 未配置价格的模型（仅计 token，不计费用）：${unpriced.join(', ')}`);
  return lines.join('\n');
}

/** Detailed one-session report. */
export function renderDetail(result, { pricing, steps = false }) {
  const { meta, analysis } = result;
  const lines = [];
  lines.push(`会话  ${meta.id}`);
  lines.push(`标题  ${meta.title ?? '(untitled)'}`);
  lines.push(
    `创建  ${formatTime(meta.createdAt)}   工作区  ${meta.cwd ?? meta.workspaceDir}   预设  ${meta.agentPreset ?? '—'}`,
  );
  lines.push(`状态  ${activityLabel(meta)}`);
  lines.push(`日志  ${meta.logPath}`);
  lines.push('');
  lines.push(
    `费用  ${formatCny(analysis.totals.costCny)}   ·   Token ${formatTokens(analysis.totals.totalTokens)}   ·   缓存命中 ${formatPercent(analysis.totals.cacheHit)}   ·   计费采样 ${analysis.totals.samples} 次`,
  );

  if (analysis.byModel.length > 0) {
    lines.push('', '按模型');
    const rows = analysis.byModel.map((entry) => [
      entry.provider ?? '—',
      entry.model ?? 'unknown',
      entry.priceKey ?? '未定价',
      formatTokens(entry.tokens.uncachedInputTokens),
      formatTokens(entry.tokens.outputTokens),
      formatTokens(entry.tokens.cacheWriteTokens),
      formatTokens(entry.tokens.cacheReadTokens),
      entry.priced ? formatCny(entry.costCny) : '—',
      formatPercent(entry.share),
    ]);
    lines.push(
      renderTable(
        ['PROVIDER', 'MODEL', 'PRICE KEY', 'INPUT', 'OUTPUT', 'CACHE-W', 'CACHE-R', 'COST', 'SHARE'],
        rows,
        ['l', 'l', 'l', 'r', 'r', 'r', 'r', 'r', 'r'],
        [14, 26, 22, 9, 8, 9, 9, 10, 6],
      ),
    );
  }

  if (analysis.byTurn.length > 0) {
    lines.push('', '按轮次');
    const rows = analysis.byTurn.map((entry) => [
      String(entry.turn),
      String(entry.steps),
      formatTokens(entry.tokens.uncachedInputTokens),
      formatTokens(entry.tokens.outputTokens),
      formatTokens(entry.tokens.cacheWriteTokens),
      formatTokens(entry.tokens.cacheReadTokens),
      formatCny(entry.costCny),
    ]);
    lines.push(renderTable(['TURN', 'STEPS', 'INPUT', 'OUTPUT', 'CACHE-W', 'CACHE-R', 'COST'], rows, ['r', 'r', 'r', 'r', 'r', 'r', 'r']));
  }

  if (steps && analysis.records.length > 0) {
    lines.push('', '按步骤（每个计费采样一行）');
    const rows = analysis.records.map((record) => [
      String(record.turn),
      String(record.step),
      formatTime(record.time),
      record.model ?? 'unknown',
      formatTokens(record.buckets.uncachedInputTokens),
      formatTokens(record.buckets.outputTokens),
      formatTokens(record.buckets.cacheWriteTokens),
      formatTokens(record.buckets.cacheReadTokens),
      record.priced ? formatCny(record.costMicroCny / 1e6) : '—',
    ]);
    lines.push(
      renderTable(
        ['TURN', 'STEP', 'TIME', 'MODEL', 'INPUT', 'OUTPUT', 'CACHE-W', 'CACHE-R', 'COST'],
        rows,
        ['r', 'r', 'l', 'l', 'r', 'r', 'r', 'r', 'r'],
        [4, 4, 16, 24, 8, 7, 8, 8, 9],
      ),
    );
  }

  const verification = verifyProjection(result);
  if (verification !== null) {
    lines.push('', `DSH 投影校验  ${verification.ok ? '一致' : '不一致'}`);
    lines.push(
      `  DSH tokenUsage: in ${formatTokens(verification.expected.uncachedInputTokens)} · out ${formatTokens(verification.expected.outputTokens)} · cacheW ${formatTokens(verification.expected.cacheWriteTokens)} · cacheR ${formatTokens(verification.expected.cacheReadTokens)}`,
    );
    if (!verification.ok) {
      lines.push(
        `  本次计算:       in ${formatTokens(verification.actual.uncachedInputTokens)} · out ${formatTokens(verification.actual.outputTokens)} · cacheW ${formatTokens(verification.actual.cacheWriteTokens)} · cacheR ${formatTokens(verification.actual.cacheReadTokens)}`,
      );
      lines.push('  日志可能在缓存写入后继续增长；重新运行或等待会话稳定后再校验。');
    }
  }

  if (analysis.unpricedModels.length > 0) {
    lines.push('', `未定价模型：${analysis.unpricedModels.join(', ')}（token 已统计，费用为 0）`);
  }
  return lines.join('\n');
}

/** Compare computed buckets with DSH's persisted tokenUsage projection, when present. */
export function verifyProjection(result) {
  const expected = result.projection?.tokenUsage?.totals;
  if (expected === undefined || expected === null) return null;
  const actual = result.analysis.totals.tokens;
  const ok =
    expected.uncachedInputTokens === actual.uncachedInputTokens &&
    expected.outputTokens === actual.outputTokens &&
    expected.cacheReadTokens === actual.cacheReadTokens &&
    expected.cacheWriteTokens === actual.cacheWriteTokens;
  return { ok, expected, actual };
}

/** Price-table report. */
export function renderModels(pricing) {
  const lines = [`价格表（${pricing.currency} / ${pricing.unitTokens.toLocaleString('en-US')} tokens）`];
  const rows = Object.entries(pricing.models).map(([id, price]) => [
    id,
    String(price.input),
    String(price.output),
    String(price.cacheWrite),
    String(price.cacheRead),
  ]);
  lines.push('');
  lines.push(renderTable(['MODEL', 'INPUT', 'OUTPUT', 'CACHE-WRITE', 'CACHE-READ'], rows, ['l', 'r', 'r', 'r', 'r']));
  const tiered = Object.entries(pricing.models).filter(([, price]) => price.peak !== undefined);
  if (tiered.length > 0) {
    lines.push('');
    lines.push('峰值计价（上表为谷值价，峰值时段按下表收费）');
    const peakRows = tiered.map(([id, price]) => [
      id,
      String(price.peak.input),
      String(price.peak.output),
      String(price.peak.cacheWrite),
      String(price.peak.cacheRead),
    ]);
    lines.push(renderTable(['MODEL', 'INPUT', 'OUTPUT', 'CACHE-WRITE', 'CACHE-READ'], peakRows, ['l', 'r', 'r', 'r', 'r']));
    const hours = describePeakHours(tiered[0][1]);
    if (hours !== null) lines.push(`峰值时段：${hours}；其余时段按谷值价计。`);
  }
  const aliases = Object.entries(pricing.aliases);
  if (aliases.length > 0) {
    lines.push('');
    lines.push(`别名：${aliases.map(([from, to]) => `${from} → ${to}`).join('  ·  ')}`);
  }
  lines.push('');
  lines.push('规则：未定价模型仍统计 token，但费用记为 0 并在列表中标注 *。');
  lines.push('模型 id 匹配：忽略 provider 前缀与日期后缀；支持以 * 结尾的前缀通配。');
  return lines.join('\n');
}

/** Cache-hit ratio of one billed bucket set. */
export function cacheHitOf(buckets) {
  const billed = billedInputTokens(buckets);
  return billed === 0 ? null : buckets.cacheReadTokens / billed;
}
