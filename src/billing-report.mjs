import { canonicalProvider } from './pricing.mjs';
import { normalizeBilling, shanghaiDay, subscriptionReport } from './billing.mjs';

/** Aggregate original log samples across sources before any official overlay. */
export function providerUsage(results) {
  const groups = new Map();
  for (const result of results) {
    for (const record of (result.localAnalysis ?? result.analysis)?.records ?? []) {
      const provider = canonicalProvider(record.provider) ?? 'unknown';
      const day = shanghaiDay(record.time);
      const key = provider + ':' + day;
      if (!groups.has(key)) groups.set(key, { provider, day, tokens: { uncachedInputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 0 }, costMicroCny: 0, costMicroUsd: 0, cnyTokens: 0, usdTokens: 0, sessionIds: new Set() });
      const group = groups.get(key);
      let total = 0;
      for (const bucket of ['uncachedInputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens']) { const n = record.buckets?.[bucket] ?? 0; group.tokens[bucket] += n; total += n; }
      group.tokens.totalTokens += total;
      group.costMicroCny += record.costMicroCny ?? 0;
      group.costMicroUsd += record.costMicroUsd ?? 0;
      if (record.priceKey?.startsWith('usd-')) group.usdTokens += total;
      else if (record.priced === true && !['opencode', 'codex'].includes(provider)) group.cnyTokens += total;
      group.sessionIds.add((result.meta.source ?? '') + ':' + result.meta.id);
    }
  }
  return [...groups.values()].map((entry) => ({ ...entry, sessionIds: [...entry.sessionIds] }));
}

export function attachBilling(report, results, billing = {}, bounds = {}) {
  const config = normalizeBilling(billing);
  const usage = providerUsage(results);
  report.billing = { config, usage, bounds };
  if (config.mode !== 'real') return report;
  const effective = subscriptionReport(usage, config, { ...bounds, now: report.generatedAt });
  report.referenceUsage = { summary: report.summary, sessions: report.sessions, daily: report.daily, note: 'Reference usage prices only; NOT added to subscription costs.' };
  report.summary = effective.summary;
  report.providers = effective.providers;
  report.daily = { days: effective.days };
  report.sessions = [];
  report.realPricing = effective;
  return report;
}

export function realPricingCsv(report) {
  const rows = [['billing_mode', 'time_zone', 'from', 'until', 'provider', 'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', 'cost_cny', 'cost_usd', 'idle_usd', 'usd_per_million_tokens', 'configured']];
  const real = report.realPricing;
  for (const row of [...real.providers, { ...real.summary, provider: 'TOTAL' }]) rows.push(['real', real.timeZone, real.from ?? '', real.until, row.provider, row.tokens.uncachedInputTokens, row.tokens.outputTokens, row.tokens.cacheWriteTokens, row.tokens.cacheReadTokens, row.costCny.toFixed(6), row.costUsd.toFixed(6), (row.idleMicroUsd / 1e6).toFixed(6), row.tokenPrice.usdMicroPerM === null ? '' : (row.tokenPrice.usdMicroPerM / 1e6).toFixed(6), row.configured]);
  return rows.map((row) => row.map((value) => '"' + String(value).replaceAll('"', '""') + '"').join(',')).join('\r\n') + '\r\n';
}
