#!/usr/bin/env node
/**
 * i18n guard for the dashboard.
 *
 * Three checks, all of which have failed at least once during development:
 *
 *   1. Both locales define exactly the same keys, with the same placeholders.
 *   2. Every key referenced from source code exists in the dictionary.
 *   3. A rendered English page contains no Han characters (a hardcoded Chinese
 *      literal would otherwise leak into the English UI unnoticed), while the
 *      Chinese page still contains them.
 *
 *   node tools/check-i18n.mjs [--root <dir>]
 *
 * Exit code 0 when everything matches, 1 on a problem (details printed).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGES, LOCALES, normalizeLocale } from '../src/i18n.mjs';
import { buildReport } from '../src/report-data.mjs';
import { normalizePricing } from '../src/pricing.mjs';
import { renderHtml } from '../src/report-html.mjs';
import { renderLiveDocument } from '../src/live.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..');
const HAN = /\p{Script=Han}/u;

/** Placeholder names used by a message, e.g. {count} -> "count". */
function placeholders(text) {
  return [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

function checkDictionaries() {
  const problems = [];
  const reference = MESSAGES[LOCALES[0]];
  for (const locale of LOCALES.slice(1)) {
    const other = MESSAGES[locale];
    const missing = Object.keys(reference).filter((key) => !(key in other));
    const extra = Object.keys(other).filter((key) => !(key in reference));
    for (const key of missing) problems.push(locale + ': missing key "' + key + '"');
    for (const key of extra) problems.push(locale + ': extra key "' + key + '"');
    for (const key of Object.keys(reference)) {
      if (!(key in other)) continue;
      const a = placeholders(reference[key]).join(',');
      const b = placeholders(other[key]).join(',');
      if (a !== b) problems.push(locale + ': placeholder mismatch in "' + key + '" (' + a + ' vs ' + b + ')');
    }
  }
  return problems;
}

function checkUsage(root) {
  const problems = [];
  const known = new Set(Object.keys(MESSAGES[LOCALES[0]]));
  const pattern = /\b(?:tr|uiText)\(\s*(?:messages\s*,\s*)?'([a-z0-9.]+)'|\bt\(\s*locale\s*,\s*'([a-z0-9.]+)'/g;
  for (const name of readdirSync(join(root, 'src'))) {
    if (!name.endsWith('.mjs') && !name.endsWith('.js')) continue;
    if (name === 'i18n.mjs') continue;
    const text = readFileSync(join(root, 'src', name), 'utf8');
    for (const match of text.matchAll(pattern)) {
      const key = match[1] ?? match[2];
      if (!known.has(key)) problems.push(name + ': unknown key "' + key + '"');
    }
  }
  return problems;
}

/** Minimal ASCII-only report used to render both locales. */
function sampleReport() {
  const pricing = normalizePricing({
    models: { 'claude-sonnet-5-5': { input: 2.3, output: 11.5, cacheWrite: 2.875, cacheRead: 0.23 } },
  });
  const buckets = { uncachedInputTokens: 1200, outputTokens: 300, cacheWriteTokens: 0, cacheReadTokens: 4000 };
  const record = {
    time: 1794000000000,
    provider: 'proxy',
    model: 'claude-sonnet-5-5',
    priceKey: 'claude-sonnet-5-5',
    priced: true,
    buckets: { ...buckets },
    costMicroCny: 1000,
    costMicroUsd: 0,
  };
  const model = {
    provider: 'proxy',
    model: 'claude-sonnet-5-5',
    priceKey: 'claude-sonnet-5-5',
    priced: true,
    tokens: { ...buckets },
    costCny: 0.001,
    costMicroCny: 1000,
    costUsd: 0,
    costMicroUsd: 0,
    share: 1,
    samples: 1,
  };
  const analysis = {
    records: [record],
    totals: {
      tokens: { ...buckets },
      totalTokens: 5500,
      costMicroCny: 1000,
      costCny: 0.001,
      costMicroUsd: 0,
      costUsd: 0,
      cacheHit: 4000 / 5200,
      samples: 1,
    },
    byModel: [model],
    byTurn: [],
    unpricedModels: [],
  };
  return buildReport({
    home: 'demo',
    sources: [{ label: 'host', home: 'demo' }],
    pricing,
    results: [{ meta: { id: 's1', title: 'demo session', createdAt: 1794000000000, source: 'host' }, analysis }],
    generatedAt: 1794003600000,
  });
}

/** Visible text only: scripts (JSON payload + runtime source) and the language
 * switch link are not part of the rendered chrome. */
function visibleText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<a class="lang-link"[\s\S]*?<\/a>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
}

function hanSamples(html, limit = 6) {
  const found = [];
  const lines = visibleText(html).split('\n');
  for (const line of lines) {
    if (!HAN.test(line)) continue;
    found.push(line.trim().slice(0, 160));
    if (found.length >= limit) break;
  }
  return found;
}

function checkClient(root) {
  const problems = [];
  const source = readFileSync(join(root, 'src', 'live-client.js'), 'utf8');
  if (!source.includes("'lang=' + locale")) {
    problems.push('live-client.js: the fragment request must carry the page locale (bug: refresh flipped the page back to Chinese)');
  }
  if (!source.includes('messages: MESSAGES')) {
    problems.push('live-client.js: applyTimeRange must receive the message table (bug: cards reverted to Chinese after a refresh)');
  }
  return problems;
}

function checkRender(root) {
  const problems = [];
  const report = sampleReport();
  const english = renderHtml(report, { locale: 'en' });
  if (HAN.test(visibleText(english))) {
    problems.push('English report still contains Chinese characters:');
    for (const line of hanSamples(english)) problems.push('    ' + line);
  }
  const chinese = renderHtml(report, { locale: 'zh' });
  if (!HAN.test(visibleText(chinese))) problems.push('Chinese report contains no Chinese characters (did the locale wiring break?)');
  const live = renderLiveDocument({ report, locale: 'en', mode: 'http' });
  if (HAN.test(visibleText(live))) {
    problems.push('English live page still contains Chinese characters:');
    for (const line of hanSamples(live)) problems.push('    ' + line);
  }
  return problems;
}

function main(argv) {
  let root = DEFAULT_ROOT;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') { root = resolve(argv[i + 1] ?? root); i += 1; }
    else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write('usage: check-i18n.mjs [--root <dir>]\n');
      return 0;
    } else {
      process.stderr.write('check-i18n: unknown argument ' + argv[i] + '\n');
      return 2;
    }
  }
  const problems = [...checkDictionaries(), ...checkUsage(root), ...checkClient(root), ...checkRender(root)];
  const counts = LOCALES.map((locale) => locale + '=' + Object.keys(MESSAGES[locale]).length).join(' ');
  if (problems.length === 0) {
    process.stdout.write('ok: ' + counts + ' keys, both locales render cleanly\n');
    return 0;
  }
  process.stdout.write('i18n problems (' + counts + '):\n');
  for (const problem of problems) process.stdout.write('  - ' + problem + '\n');
  return 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
