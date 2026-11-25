/**
 * Provider-scoped price pages.
 *
 * The dashboard's price section no longer prints a rate table inline: it lists
 * one link per provider, and each link opens a separate page on the same origin
 * (a new tab, target=_blank + rel=noopener noreferrer). The link carries only the
 * provider id, never a session id, title or workspace, so opening it cannot leak
 * conversation data to another origin or referrer.
 *
 * Pages are plain server-rendered HTML: the static CLI snapshot writes them next
 * to the report as pricing-<id>.html, the live server answers /pricing/<id>.
 * Because they are ordinary documents, a live fragment refresh of the dashboard
 * cannot break an already-open price page.
 */
import { writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { formatUsd } from './money.mjs';
import { formatCny, formatTokens } from './pricing.mjs';
import { buildProviderUsage } from './report-data.mjs';
import { summarizeProviderPricing } from './provider-pricing.mjs';
import { normalizeLocale, t } from './i18n.mjs';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escape one value (a local copy keeps this module out of a render cycle). */
export function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (char) => ESCAPES[char]);
}

/** Shortest exact decimal text, e.g. 8 -> "8", 0.125 -> "0.125". */
export function rateText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return String(Number(value.toFixed(6)));
}

/** Context limit as published: 272000 -> "272K", 100000 -> "100K". */
export function limitText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  if (value >= 1000 && value % 1000 === 0) return String(value / 1000) + 'K';
  return String(value);
}

/** True when the local CNY table still prices DeepSeek (drives the page list). */
function hasDeepseekModel(pricing) {
  return Object.keys(pricing?.models ?? {}).some((id) => id.startsWith('deepseek'));
}

/** Path of the static companion file for one provider page. */
export function providerPageFileName(providerId) {
  return 'pricing-' + String(providerId).replace(/[^A-Za-z0-9._-]/gu, '_') + '.html';
}

/** Same-origin route used by the live server. */
export function providerPageHref(providerId) {
  return '/pricing/' + encodeURIComponent(String(providerId));
}

/**
 * One entry per provider that has a page: the configured providers first, then
 * any route the report actually billed that has no configured card.
 */
export function providerPageEntries({ report, card = null, usdPricing = null, pricing = null, locale = 'zh' } = {}) {
  const loc = normalizeLocale(locale);
  const tr = (key, params) => t(loc, key, params);
  const entries = [];
  if (card !== null && card !== undefined) {
    const counts = summarizeProviderPricing(card);
    entries.push({
      id: card.provider,
      kind: 'card',
      title: 'AICodeMirror',
      badge: card.provider,
      desc: tr('price.desc.aicodemirror'),
      counts: tr('price.card.counts', { groups: counts.groups, models: counts.models, tiers: counts.tiers }),
    });
  }
  if (usdPricing !== null && usdPricing !== undefined && usdPricing.providers.length > 0) {
    entries.push({
      id: 'codex',
      kind: 'usd',
      title: 'OpenAI Codex',
      badge: usdPricing.providers.join(' / '),
      desc: tr('price.desc.codex'),
      counts: tr('price.card.models', { count: Object.keys(usdPricing.models).length }),
    });
  }
  entries.push({ id: 'opencode', kind: 'official', title: 'OpenCode', badge: 'opencode', desc: tr('price.desc.opencode'), counts: '' });
  if (hasDeepseekModel(pricing)) {
    entries.push({ id: 'deepseek', kind: 'local', title: 'DeepSeek', badge: 'deepseek', desc: tr('price.desc.deepseek'), counts: '' });
  }
  for (const usage of report?.providerUsage ?? []) {
    const id = usage.provider;
    if (typeof id !== 'string' || id === '' || id === 'unknown' || entries.some((entry) => entry.id === id)) continue;
    entries.push({ id, kind: 'other', title: id, badge: id, desc: tr('price.desc.other'), counts: '' });
  }
  const usageById = new Map((report?.providerUsage ?? []).map((usage) => [usage.provider, usage]));
  return entries.map((entry) => {
    const usage = usageById.get(entry.id) ?? null;
    return {
      ...entry,
      usage,
      usageText:
        usage === null || usage === undefined || ((usage.costMicroCny ?? 0) === 0 && (usage.costMicroUsd ?? 0) === 0 && usage.totalTokens === 0)
          ? ''
          : tr('price.card.usage', { cost: usageText(usage), tokens: formatTokens(usage.totalTokens) }),
    };
  });
}

/** Two-currency text for one usage aggregate. */
function usageText(usage) {
  const parts = [];
  if ((usage.costMicroCny ?? 0) > 0) parts.push(formatCny(usage.costMicroCny / 1e6));
  if ((usage.costMicroUsd ?? 0) > 0) parts.push(formatUsd(usage.costMicroUsd / 1e6));
  return parts.length === 0 ? formatCny(0) : parts.join(' + ');
}

/** The price section of the dashboard: one link per provider, no inline rates. */
export function renderPriceLinks({ report, card = null, usdPricing = null, pricing = null, locale = 'zh', hrefFor = null } = {}) {
  const loc = normalizeLocale(locale);
  const tr = (key, params) => t(loc, key, params);
  const href = typeof hrefFor === 'function' ? hrefFor : (id) => providerPageHref(id);
  const entries = providerPageEntries({ report, card, usdPricing, pricing, locale: loc });
  const links = entries
    .map((entry) => {
      const meta = [entry.counts, entry.usageText].filter((part) => part !== '').join(' · ');
      return [
        '<a class="provider-link" data-provider="' + escapeText(entry.id) + '" href="' + escapeText(href(entry.id)) + '" target="_blank" rel="noopener noreferrer">',
        '<span class="pl-top">',
        '<span class="pl-title">' + escapeText(entry.title) + '</span>',
        '<span class="pl-badge mono">' + escapeText(entry.badge) + '</span>',
        '</span>',
        '<span class="pl-desc">' + escapeText(entry.desc) + '</span>',
        meta === '' ? '' : '<span class="pl-meta">' + escapeText(meta) + '</span>',
        '<span class="pl-go">' + escapeText(tr('price.links.open')) + ' ↗</span>',
        '</a>',
      ].join('');
    })
    .join('');
  return [
    '<section id="price-links" data-pricing-section="providers">',
    '<h2>' + escapeText(tr('price.links.title')) + '</h2>',
    '<div class="provider-links">' + links + '</div>',
    '<div class="note">' + escapeText(tr('price.links.note')) + '</div>',
    '</section>',
  ].join('');
}

const PAGE_CSS = [
  ":root {",
  "    --bg: #f4f6f9; --card: #ffffff; --text: #1c2430; --muted: #6b7787; --line: #e3e8ef;",
  "    --accent: #0f766e; --accent-soft: #ccfbf1; --warn: #b45309; --warn-soft: #fef3c7;",
  "    --mono: ui-monospace, \"Cascadia Code\", \"SFMono-Regular\", Consolas, monospace;",
  "  }",
  "  * { box-sizing: border-box; }",
  "  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.6 -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Microsoft YaHei\", \"PingFang SC\", sans-serif; -webkit-font-smoothing: antialiased; }",
  "  .pp-wrap { max-width: 1080px; margin: 0 auto; padding: 40px 24px 56px; }",
  "  .pp-eyebrow { font-size: 12px; letter-spacing: .14em; color: var(--accent); font-weight: 700; text-transform: uppercase; }",
  "  h1 { font-size: 26px; line-height: 1.3; margin: 8px 0 6px; font-weight: 650; letter-spacing: -.01em; }",
  "  h1 .pp-id { font-family: var(--mono); font-size: 14px; color: var(--muted); font-weight: 500; margin-left: 8px; }",
  "  .pp-lede { color: var(--text); margin: 6px 0; }",
  "  .pp-meta { color: var(--muted); font-size: 12px; margin: 4px 0; }",
  "  .pp-back { display: inline-block; margin-top: 10px; font-size: 12px; color: var(--accent); text-decoration: none; border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; background: var(--card); }",
  "  .pp-back:hover { border-color: var(--accent); }",
  "  .pp-card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; margin: 16px 0; overflow: hidden; }",
  "  .pp-card > h2 { font-size: 13px; font-weight: 650; letter-spacing: .04em; color: var(--muted); margin: 0; padding: 16px 20px 10px; text-transform: uppercase; }",
  "  .pp-card > h2 .pp-factor { float: right; font-family: var(--mono); text-transform: none; color: var(--accent); }",
  "  .pp-card > .pp-body { padding: 0 20px 16px; }",
  "  .table-wrap { overflow-x: auto; }",
  "  table { width: 100%; border-collapse: collapse; font-size: 13px; }",
  "  th, td { padding: 9px 12px; text-align: left; vertical-align: middle; border-top: 1px solid var(--line); }",
  "  thead th { border-top: none; color: var(--muted); font-weight: 600; font-size: 11px; letter-spacing: .05em; text-transform: uppercase; white-space: nowrap; }",
  "  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }",
  "  .mono { font-family: var(--mono); font-size: 12px; }",
  "  .muted { color: var(--muted); }",
  "  .rate { display: inline-flex; flex-direction: column; align-items: flex-end; line-height: 1.35; }",
  "  .rate .usd { color: var(--text); }",
  "  .rate .cny { color: var(--accent); font-size: 11.5px; }",
  "  tr.is-long td { background: #fbfdff; }",
  "  tr.is-conflict td { background: var(--warn-soft); }",
  "  tr.pp-note-row td { background: #fffbeb; color: var(--warn); font-size: 12px; }",
  "  .chip { display: inline-block; border-radius: 999px; padding: 0 8px; font-size: 11px; font-weight: 650; line-height: 18px; }",
  "  .chip-warn { background: var(--warn-soft); color: var(--warn); border: 1px solid #fcd34d; }",
  "  .chip-ok { background: var(--accent-soft); color: var(--accent); border: 1px solid #99f6e4; }",
  "  .chip-muted { background: #eef2f6; color: var(--muted); border: 1px solid var(--line); }",
  "  .note { padding: 12px 20px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--line); }",
  "  .note.warn { background: var(--warn-soft); color: var(--warn); border-top-color: #fcd34d; }",
  "  footer { color: var(--muted); font-size: 12px; text-align: center; margin-top: 26px; line-height: 1.8; }",
  "  @media (max-width: 720px) { .pp-wrap { padding: 24px 14px 40px; } h1 { font-size: 22px; } }",
].join('\n');

/** Rate cells: the USD quote first, then the CNY rate billing actually applies. */
function rateCells(tier) {
  const cell = (usd, cny) => {
    if (usd === null || usd === undefined) return '<span class="muted" title="' + escapeText('not published') + '">—</span>';
    return '<span class="rate"><span class="usd">' + escapeText('$' + rateText(usd)) + '</span><span class="cny">' + escapeText('¥' + rateText(cny)) + '</span></span>';
  };
  return [
    cell(tier.usd.input, tier.cny.input),
    cell(tier.usd.output, tier.cny.output),
    cell(tier.usd.cacheWrite, tier.cny.cacheWrite),
    cell(tier.usd.cacheRead, tier.cny.cacheRead),
  ].map((html) => '<td class="num">' + html + '</td>').join('');
}

/** Overlap of two published tiers, e.g. standard "<=272K" vs long ">100K". */
export function tierOverlap(model) {
  for (const upper of model.tiers) {
    if (upper.upTo === null) continue;
    for (const lower of model.tiers) {
      if (lower === upper || lower.over === null) continue;
      if (lower.over < upper.upTo) return { over: lower.over, upTo: upper.upTo, lower: lower.id, upper: upper.id };
    }
  }
  return null;
}

/** Tier label, e.g. "<=272K" / ">100K"; a single unbounded tier reads "any". */
function tierLabel(tier, tr) {
  if (tier.upTo === null && tier.over === null) return tr('price.tier.any');
  if (tier.upTo !== null) return tr('price.tier.standard', { limit: limitText(tier.upTo) });
  return tr('price.tier.long', { limit: limitText(tier.over) });
}

/** One group section: header with the factor, then one row per published tier. */
function groupSection(group, tr) {
  const rows = [];
  for (const model of group.models) {
    const overlap = tierOverlap(model);
    for (const tier of model.tiers) {
      rows.push(
        '<tr class="' + (tier.id === 'long' ? 'is-long ' : '') + (overlap !== null ? 'is-conflict' : '') + '">' +
          '<td class="mono">' + escapeText(model.id) + '</td>' +
          '<td>' + escapeText(tierLabel(tier, tr)) + (overlap !== null ? ' <span class="chip chip-warn">' + escapeText(tr('price.conflict.badge')) + '</span>' : '') + '</td>' +
          rateCells(tier) +
          '</tr>',
      );
    }
    if (overlap !== null) {
      rows.push(
        '<tr class="pp-note-row"><td colspan="6">' +
          escapeText(tr('price.conflict.note', { model: model.id, over: limitText(overlap.over), upTo: limitText(overlap.upTo) })) +
          '</td></tr>',
      );
    }
  }
  return [
    '<section class="pp-card" data-group="' + escapeText(group.id) + '">',
    '<h2>' + escapeText(group.label) + '<span class="pp-factor">x' + escapeText(rateText(group.factor)) + '</span></h2>',
    '<div class="table-wrap"><table>',
    '<thead><tr><th>' + escapeText(tr('table.model')) + '</th><th>' + escapeText(tr('price.table.tier')) + '</th>' +
      '<th class="num">' + escapeText(tr('price.table.input')) + '</th>' +
      '<th class="num">' + escapeText(tr('price.table.output')) + '</th>' +
      '<th class="num">' + escapeText(tr('price.table.cacheWrite')) + '</th>' +
      '<th class="num">' + escapeText(tr('price.table.cacheRead')) + '</th></tr></thead>',
    '<tbody>' + rows.join('') + '</tbody>',
    '</table></div>',
    '<div class="note">' + escapeText(tr('price.group.formula', { factor: rateText(group.factor) })) + '</div>',
    '</section>',
  ].join('');
}

/** Usage rows for one provider: aggregates only, never a session id. */
function usageSection(usage, tr) {
  if (usage === null || usage === undefined || usage.models.length === 0) {
    return '<section class="pp-card"><h2>' + escapeText(tr('price.page.usage')) + '</h2><div class="note">' + escapeText(tr('price.page.usage.empty')) + '</div></section>';
  }
  const rows = usage.models
    .map((row) => {
      const pending = row.priceKey === 'opencode-pending';
      const status = pending ? tr('price.usage.pending') : row.priced ? (row.estimated ? tr('price.usage.estimated') : tr('price.usage.priced')) : tr('price.usage.unpriced');
      const chipClass = pending ? 'chip-muted' : row.priced ? (row.estimated ? 'chip-warn' : 'chip-ok') : 'chip-warn';
      const label = row.contextTier === null || row.contextTier === undefined ? row.model : row.model + ' · ' + row.contextTier;
      return '<tr>' +
        '<td class="mono">' + escapeText(label ?? '-') + '</td>' +
        '<td class="num">' + escapeText(formatTokens(row.tokens.uncachedInputTokens + row.tokens.outputTokens + row.tokens.cacheWriteTokens + row.tokens.cacheReadTokens)) + '</td>' +
        '<td class="num">' + escapeText(usageText(row)) + '</td>' +
        '<td><span class="chip ' + chipClass + '">' + escapeText(status) + '</span></td>' +
        '</tr>';
    })
    .join('');
  return [
    '<section class="pp-card">',
    '<h2>' + escapeText(tr('price.page.usage')) + '</h2>',
    '<div class="table-wrap"><table>',
    '<thead><tr><th>' + escapeText(tr('table.model')) + '</th><th class="num">' + escapeText(tr('table.token')) + '</th><th class="num">' + escapeText(tr('table.cost')) + '</th><th>' + escapeText(tr('price.table.status')) + '</th></tr></thead>',
    '<tbody>' + rows + '</tbody>',
    '</table></div>',
    '<div class="note">' + escapeText(tr('price.page.usage.note')) + '</div>',
    '</section>',
  ].join('');
}

/**
 * Render one standalone provider page.
 *
 * @returns {string|null} HTML document, or null when the id has no page.
 */
export function renderProviderPage({ id, report = null, card = null, usdPricing = null, pricing = null, locale = 'zh', backHref = '/', generatedAt = null } = {}) {
  const loc = normalizeLocale(locale);
  const tr = (key, params) => t(loc, key, params);
  const entries = providerPageEntries({ report, card, usdPricing, pricing, locale: loc });
  const entry = entries.find((item) => item.id === id);
  if (entry === undefined) return null;
  const usage =
    entry.usage ??
    (report === null || report === undefined
      ? null
      : buildProviderUsage(report.sessions ?? []).find((row) => row.provider === id) ?? null);
  const generated = generatedAt ?? report?.generatedAt ?? Date.now();
  const timeText = new Date(generated).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const sections = [];
  const lede = [entry.counts, entry.usageText].filter((part) => part !== '').join(' · ');

  if (entry.kind === 'card' && card !== null) {
    const counts = summarizeProviderPricing(card);
    const factorList = card.groups.map((group) => group.label + ' ' + rateText(group.factor)).join(' · ');
    sections.push(
      '<section class="pp-card"><h2>' + escapeText(tr('price.page.formulaTitle')) + '</h2>' +
        '<div class="pp-body"><p>' + escapeText(tr('price.page.formulaIntro')) + '</p><p>' + escapeText(tr('price.page.factors', { list: factorList })) + '</p>' +
        '<p class="muted">' + escapeText(tr('price.page.counts', { groups: counts.groups, models: counts.models, tiers: counts.tiers, longTiers: counts.longTiers })) + '</p></div>' +
        (card.source ? '<div class="note">' + escapeText(tr('price.page.sourceNote', { source: card.source })) + '</div>' : '') +
        (card.policy ? '<div class="note">' + escapeText(tr('price.page.policyNote', { policy: card.policy })) + '</div>' : '') +
        '</section>',
    );
    for (const group of card.groups) sections.push(groupSection(group, tr));
    const missing = card.groups.some((group) => group.models.some((model) => model.tiers.some((tier) => tier.usd.cacheWrite === null)));
    if (missing) sections.push('<div class="note warn">' + escapeText(tr('price.missing.note')) + '</div>');
  } else if (entry.kind === 'usd' && usdPricing !== null) {
    // The USD table is four rates per model, exactly as config/usd-pricing.json
    // publishes it: the long-context surcharge is not modelled, so no long row
    // is invented here and no other provider's card can overwrite these rates.
    const rows = Object.entries(usdPricing.models)
      .map(([model, price]) => {
        const cell = (value) => '<td class="num"><span class="rate"><span class="usd">' + escapeText(value === null || value === undefined ? '—' : '$' + rateText(value)) + '</span></span></td>';
        return (
          '<tr>' +
          '<td class="mono">' + escapeText(model) + '</td>' +
          '<td>' + escapeText(tr('price.tier.unboundedUsd')) + '</td>' +
          cell(price.input) + cell(price.output) + cell(price.cacheWrite) + cell(price.cacheRead) +
          '</tr>'
        );
      })
      .join('');
    sections.push(
      '<section class="pp-card"><h2>' + escapeText(tr('price.page.rates')) + '</h2>' +
        '<div class="table-wrap"><table>' +
        '<thead><tr><th>' + escapeText(tr('table.model')) + '</th><th>' + escapeText(tr('price.table.tier')) + '</th><th class="num">' + escapeText(tr('price.table.input')) + '</th><th class="num">' + escapeText(tr('price.table.output')) + '</th><th class="num">' + escapeText(tr('price.table.cacheWrite')) + '</th><th class="num">' + escapeText(tr('price.table.cacheRead')) + '</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>' +
        '<div class="note">' + escapeText(tr('price.codex.note')) + '</div>' +
        '<div class="note">' + escapeText(tr('price.codex.providers', { list: usdPricing.providers.join(', ') })) + '</div>' +
        '</section>',
    );
  } else if (entry.kind === 'official') {
    const official = report?.official ?? null;
    sections.push(
      '<section class="pp-card"><h2>' + escapeText(tr('price.page.officialTitle')) + '</h2><div class="pp-body"><p>' + escapeText(tr('price.opencode.note')) + '</p>' +
        (official === null
          ? '<p class="muted">' + escapeText(tr('price.opencode.none')) + '</p>'
          : '<p>' + escapeText(tr('price.opencode.requests', { requests: official.requests, sessions: official.sessions })) + '</p>' +
            (official.windows
              ? '<p>' + escapeText(tr('price.opencode.windows', {
                  today: formatUsd(official.windows.today),
                  seven: formatUsd(official.windows['7d']),
                  thirty: formatUsd(official.windows['30d']),
                })) + '</p>'
              : '') +
            (official.skippedMixed > 0 ? '<p class="muted">' + escapeText(tr('price.opencode.mixed', { count: official.skippedMixed })) + '</p>' : '')) +
        '</div></section>',
    );
  } else if (entry.kind === 'local') {
    const deepseek = pricing === null ? null : Object.entries(pricing.models).find(([model]) => model.startsWith('deepseek'));
    const peakModel = deepseek !== null && deepseek !== undefined && deepseek[1].peak !== undefined ? deepseek[0] : null;
    sections.push(
      '<section class="pp-card"><h2>' + escapeText(tr('price.page.localTitle')) + '</h2><div class="pp-body">' +
        '<p>' + escapeText(tr('price.deepseek.hidden')) + '</p>' +
        (peakModel === null ? '' : '<p class="muted">' + escapeText(tr('price.deepseek.hours', { model: peakModel })) + '</p>') +
        '</div><div class="note">' + escapeText(tr('price.deepseek.note')) + '</div></section>',
    );
  } else {
    sections.push('<section class="pp-card"><h2>' + escapeText(tr('price.page.otherTitle')) + '</h2><div class="pp-body"><p>' + escapeText(tr('price.other.note')) + '</p></div></section>');
  }

  sections.push(usageSection(usage, tr));

  return [
    '<!doctype html>',
    '<html lang="' + (loc === 'en' ? 'en' : 'zh-CN') + '">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<title>' + escapeText(tr('price.page.title', { provider: entry.title })) + '</title>',
    '<style>' + PAGE_CSS + '</style>',
    '</head>',
    '<body>',
    '<div class="pp-wrap">',
    '<div class="pp-eyebrow">' + escapeText(tr('price.page.eyebrow')) + '</div>',
    '<h1>' + escapeText(entry.title) + '<span class="pp-id">' + escapeText(entry.badge) + '</span></h1>',
    '<p class="pp-lede">' + escapeText(entry.desc) + '</p>',
    lede === '' ? '' : '<p class="pp-meta">' + escapeText(lede) + '</p>',
    '<p class="pp-meta">' + escapeText(tr('price.page.generated', { time: timeText })) + (report?.home ? ' · ' + escapeText(tr('price.page.source', { home: report.home })) : '') + '</p>',
    '<a class="pp-back" href="' + escapeText(backHref) + '">' + escapeText(tr('price.page.back')) + '</a>',
    sections.join(''),
    '<footer>' + escapeText(tr('price.page.footer')) + '</footer>',
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * Write every provider page next to a static report.
 * @returns {string[]} absolute paths written.
 */
export function writeProviderPages({ outPath, report, card = null, usdPricing = null, pricing = null, locale = 'zh' } = {}) {
  const target = resolve(outPath);
  const directory = dirname(target);
  const backHref = basename(target);
  const written = [];
  for (const entry of providerPageEntries({ report, card, usdPricing, pricing, locale })) {
    const html = renderProviderPage({ id: entry.id, report, card, usdPricing, pricing, locale, backHref, generatedAt: report?.generatedAt });
    if (html === null) continue;
    const file = resolve(directory, providerPageFileName(entry.id));
    writeFileSync(file, html, 'utf8');
    written.push(file);
  }
  return written;
}
