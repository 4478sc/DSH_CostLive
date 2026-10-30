#!/usr/bin/env node
/** dsh-cost command line: session cost accounting over DSH durable logs. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sortSessionResults } from './activity.mjs';
import { analyzeEvents } from './engine.mjs';
import { loadPricing, formatCny } from './pricing.mjs';
import { buildReport, toCsv } from './report-data.mjs';
import { renderHtml } from './report-html.mjs';
import { renderDetail, renderList, renderModels, verifyProjection } from './report-text.mjs';
import { discoverSessions, matchSession, readSession } from './sessions.mjs';
import { loadSources } from './sources.mjs';

const COMMANDS = new Set(['list', 'session', 'models', 'report', 'help']);
const VALUE_FLAGS = new Set(['home', 'workspace', 'model', 'since', 'until', 'format', 'out', 'top', 'pricing']);

const HELP = `dsh-cost — DeepSeek Harness 会话费用（CNY）

用法
  dsh-cost [list] [选项]              会话费用总览（默认命令）
  dsh-cost session <id|前缀> [选项]   单个会话明细
  dsh-cost models [--pricing <file>]  查看价格表
  dsh-cost report [--format html]     生成报告（html/json/csv）

选项
  --home <dir>         DSH 数据目录（默认 $DSH_HOME 或 ~/.dsh）
  --source <label=dir> 追加一个数据源；可重复（例如 主机 / VM）
  --sources <file>     从 JSON 读取多个数据源（label + home）
  --pricing <file>     自定义价格表 JSON（默认 config/pricing.json）
  --workspace <text>   按工作区目录名过滤
  --model <text>       仅显示使用该模型（子串匹配）的会话
  --since <date>       会话创建时间下界（YYYY-MM-DD 或 ISO）
  --until <date>       会话创建时间上界
  --priced-only        仅显示费用大于 0 的会话
  --all                包含没有用量记录的会话
  --top <n>            仅显示费用最高的 n 个会话（结果内运行中优先）
  --steps              明细中包含每个计费采样
  --format <fmt>       table | json | csv | html（report 默认 html）
  --out <file>         报告输出文件（html/csv）
  --json               --format json 的简写
  --verify             仅校验：对比 DSH tokenUsage 投影（有缓存时）
  -h, --help           显示帮助

退出码
  0 成功 · 1 未找到会话/无数据 · 2 参数错误

示例
  dsh-cost --model claude-sonnet-5-5
  dsh-cost session 9e014471 --steps
  dsh-cost report --format html --out dsh-cost.html
  dsh-cost --home "C:\\Users\\me\\.dsh" --since 2026-10-01
`;

/** Parse `--key value` / `--key=value` / boolean flags. */
function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg === '-h') {
      options.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    let name = arg.slice(2);
    let value;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (name === 'json') {
      options.format = 'json';
      continue;
    }
    if (name === 'help' || name === 'h') {
      options.help = true;
      continue;
    }
    if (name === 'source' || name === 'sources') {
      if (value === undefined) {
        value = argv[index + 1];
        index += 1;
      }
      if (value === undefined) throw new Error(`option --${name} requires a value`);
      if (name === 'source') (options.source ??= []).push(value);
      else options.sources = value;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      if (value === undefined) {
        value = argv[index + 1];
        index += 1;
      }
      if (value === undefined) throw new Error(`option --${name} requires a value`);
      options[name] = value;
      continue;
    }
    if (name === 'steps' || name === 'priced-only' || name === 'all' || name === 'verify' || name === 'verbose') {
      options[name] = true;
      continue;
    }
    throw new Error(`unknown option --${name}`);
  }
  return { positionals, options };
}

/** Parse a date bound: date-only means local start/end of day. */
function parseDateBound(value, endOfDay) {
  if (value === undefined) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(value);
  const ms = Date.parse(dateOnly ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}` : value);
  if (!Number.isFinite(ms)) throw new Error(`invalid date: ${value}`);
  return ms;
}

/** Analyze every discovered session; unreadable logs are reported, never fatal. */
function analyzeAll(descriptors, pricing, options) {
  const results = [];
  for (const descriptor of descriptors) {
    try {
      const { meta, events, badLines, projection } = readSession(descriptor);
      meta.source = descriptor.source ?? null;
      meta.sourceHome = descriptor.sourceHome ?? null;
      if (badLines > 0 && options.verbose) process.stderr.write(`warning: ${meta.id}: skipped ${badLines} malformed log line(s)\n`);
      const analysis = analyzeEvents(events, pricing);
      results.push({ meta, analysis, projection });
    } catch (error) {
      process.stderr.write(`warning: cannot read ${descriptor.logPath}: ${error.message}\n`);
    }
  }
  return results;
}

/** Apply model / usage / priced filters over analyzed sessions. */
function filterResults(results, options) {
  let filtered = results;
  if (options.model !== undefined) {
    const needle = options.model.toLowerCase();
    filtered = filtered.filter((result) =>
      result.analysis.byModel.some((entry) => String(entry.model ?? '').toLowerCase().includes(needle)),
    );
  }
  if (options['priced-only'] === true) filtered = filtered.filter((result) => result.analysis.totals.costMicroCny > 0);
  if (options.all !== true) filtered = filtered.filter((result) => result.analysis.totals.samples > 0);
  // Cost order still decides what `--top` selects; running-first ordering is
  // applied afterwards so the flag keeps meaning "highest cost".
  filtered.sort((a, b) => b.analysis.totals.costMicroCny - a.analysis.totals.costMicroCny || (b.meta.createdAt ?? 0) - (a.meta.createdAt ?? 0));
  if (options.top !== undefined) {
    const top = Number.parseInt(options.top, 10);
    if (!Number.isInteger(top) || top <= 0) throw new Error('--top must be a positive integer');
    filtered = filtered.slice(0, top);
  }
  return sortSessionResults(filtered);
}

/** Write a generated report file, creating parent directories. */
function writeOut(path, content) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
}

/** Entry point; returns the process exit code. */
export function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`dsh-cost: ${error.message}\n\n${HELP}`);
    return 2;
  }
  const { positionals, options } = parsed;
  if (options.help === true || positionals[0] === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  const command = positionals[0] !== undefined && COMMANDS.has(positionals[0]) ? positionals[0] : 'list';
  const rest = command === 'list' ? positionals : positionals.slice(1);
  const sessionQuery = command === 'session' ? rest[0] : undefined;
  if (command === 'session' && sessionQuery === undefined) {
    process.stderr.write('dsh-cost: session requires a session id or unique prefix\n');
    return 2;
  }

  let pricing;
  try {
    pricing = loadPricing(options.pricing === undefined ? undefined : resolve(options.pricing));
  } catch (error) {
    process.stderr.write(`dsh-cost: ${error.message}\n`);
    return 2;
  }

  if (command === 'models') {
    process.stdout.write(`${renderModels(pricing)}\n`);
    return 0;
  }

  let sources;
  try {
    sources = loadSources({
      sources: options.source,
      sourcesPath: options.sources,
      home: options.home,
    });
  } catch (error) {
    process.stderr.write(`dsh-cost: ${error.message}\n`);
    return 2;
  }

  let since;
  let until;
  try {
    since = parseDateBound(options.since, false);
    until = parseDateBound(options.until, true);
  } catch (error) {
    process.stderr.write(`dsh-cost: ${error.message}\n`);
    return 2;
  }

  const format = options.format ?? (command === 'report' ? 'html' : 'table');
  if (!['table', 'json', 'csv', 'html'].includes(format)) {
    process.stderr.write(`dsh-cost: unknown format "${format}" (table|json|csv|html)\n`);
    return 2;
  }

  const descriptors = [];
  const sourceStats = [];
  for (const source of sources) {
    if (!existsSync(source.home)) {
      const message = `DSH 数据目录不存在: ${source.home}`;
      process.stderr.write(`dsh-cost: ${source.label}: ${message}\n`);
      sourceStats.push({ label: source.label, home: source.home, sessions: 0, error: message });
      continue;
    }
    const found = discoverSessions({
      home: source.home,
      workspace: options.workspace,
      since,
      until,
      id: sessionQuery,
    });
    sourceStats.push({ label: source.label, home: source.home, sessions: 0, error: null });
    for (const descriptor of found) {
      descriptor.source = source.label;
      descriptor.sourceHome = source.home;
      descriptors.push(descriptor);
    }
  }
  if (descriptors.length === 0) {
    process.stderr.write(
      `dsh-cost: no sessions found under ${sources.map((source) => `${source.label}=${source.home}`).join(', ')}${
        sessionQuery ? ` matching "${sessionQuery}"` : ''
      }\n`,
    );
    return 1;
  }
  const home = sourceStats.find((source) => source.error === null)?.home ?? sources[0].home;

  let selected = descriptors;
  if (sessionQuery !== undefined) {
    const matched = matchSession(descriptors, sessionQuery);
    if (matched.error !== undefined) {
      process.stderr.write(`dsh-cost: ${matched.error}\n`);
      return 1;
    }
    selected = [matched.session];
  }

  let results;
  try {
    results = filterResults(analyzeAll(selected, pricing, options), options);
  } catch (error) {
    process.stderr.write(`dsh-cost: ${error.message}\n`);
    return 2;
  }
  if (results.length === 0) {
    process.stderr.write('dsh-cost: no sessions match the current filters\n');
    return 1;
  }
  for (const source of sourceStats) {
    source.sessions = results.filter((result) => result.meta.source === source.label).length;
  }

  const generatedAt = Date.now();
  if (format === 'json') {
    const report = buildReport({ home, sources: sourceStats, pricing, results, generatedAt });
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (options.out !== undefined) {
      const target = writeOut(options.out, text);
      process.stdout.write(`JSON 已生成: ${target}\n`);
    } else {
      process.stdout.write(text);
    }
    return 0;
  }
  if (format === 'csv') {
    const report = buildReport({ home, sources: sourceStats, pricing, results, generatedAt });
    if (options.out !== undefined) {
      // A UTF-8 BOM keeps Excel on Windows from reading Chinese titles as ANSI.
      const target = writeOut(options.out, `\uFEFF${toCsv(report)}`);
      process.stdout.write(`CSV 已生成: ${target}\n`);
    } else {
      process.stdout.write(toCsv(report));
    }
    return 0;
  }
  if (format === 'html') {
    const report = buildReport({ home, sources: sourceStats, pricing, results, generatedAt });
    const target = writeOut(options.out ?? 'dsh-cost-report.html', renderHtml(report));
    process.stdout.write(`HTML 报告已生成: ${target}\n`);
    process.stdout.write(`会话 ${report.summary.sessions} 个 · 总费用 ${formatCny(report.summary.costCny)} · Token ${report.summary.totalTokens.toLocaleString('en-US')}\n`);
    return 0;
  }

  if (command === 'session') {
    const result = results[0];
    process.stdout.write(`${renderDetail(result, { pricing, steps: options.steps === true })}\n`);
    return 0;
  }
  process.stdout.write(`${renderList(results, { pricing, home, sources: sourceStats, generatedAt })}\n`);
  if (options.verify === true) {
    const checked = results.map((result) => ({ result, verification: verifyProjection(result) })).filter((entry) => entry.verification !== null);
    const mismatched = checked.filter((entry) => !entry.verification.ok);
    process.stdout.write(`\nDSH 投影校验  ${checked.length} 个会话可比对 · ${mismatched.length} 个不一致\n`);
    for (const entry of mismatched.slice(0, 10)) process.stdout.write(`  ${entry.result.meta.id}\n`);
  }
  process.stdout.write('\n使用 "dsh-cost session <id|前缀>" 查看单会话明细，"--format html --out <file>" 生成网页报告。\n');
  return 0;
}
