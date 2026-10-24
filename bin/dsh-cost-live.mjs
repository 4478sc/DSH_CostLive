#!/usr/bin/env node
/**
 * dsh-cost-live — real-time token/cost dashboard for DeepSeek Harness.
 *
 * Modes:
 *   default   local HTTP server + browser polling (方案 B)
 *   --watch   rebuild a standalone file:/// page every N seconds (方案 C)
 *   --once    build that standalone page once and exit
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatCny, formatTokens } from '../src/pricing.mjs';
import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_OUTPUT,
  DEFAULT_PORT,
  MIN_INTERVAL_MS,
  collectLiveReport,
  parseDateBound,
  writeLiveSnapshot,
} from '../src/live.mjs';
import { clockLabel, openBrowser, startLiveServer } from '../src/live-server.mjs';

const HELP = `dsh-cost-live — DSH 会话费用实时面板（CNY）

用法
  dsh-cost-live                    启动本地实时服务（默认 http://127.0.0.1:4173/）
  dsh-cost-live --watch            每 20 秒重建独立 HTML，并自动打开浏览器
  dsh-cost-live --once             生成一次独立 HTML 快照后退出

模式
  默认        方案 B：本地 HTTP 服务；页面每 20 秒拉取 /api/fragment 并原地更新
  --watch     方案 C：后台定时重建 out/dsh-cost-live.html；file:/// 页面自动重载
  --once      生成静态快照；可加 --auto-reload 让页面在下次重建后自动重载

选项
  --port <n>            服务端口（默认 ${DEFAULT_PORT}；被占用时自动尝试 +1）
  --host <addr>         监听地址（默认 127.0.0.1，仅本机可访问）
  --interval <sec>      刷新间隔秒数（默认 20，最小 ${MIN_INTERVAL_MS / 1000}）
  --out <file>          独立 HTML 路径（默认 out/dsh-cost-live.html）
  --open                启动后打开浏览器（服务/--watch 默认打开）
  --no-open             不自动打开浏览器
  --auto-reload         --once 生成的页面也每 N 秒自动重载
  --no-auto-reload      --watch 生成的页面不自动重载（只写文件）
  --server-url <url>    独立页面里“实时版”链接的目标（默认 http://127.0.0.1:<port>/）
  --home <dir>          DSH 数据目录（默认 $DSH_HOME 或 ~/.dsh）
  --pricing <file>      自定义价格表 JSON（默认 config/pricing.json）
  --model <text>        仅包含使用该模型（子串匹配）的会话
  --workspace <text>    按工作区目录名过滤
  --since <date>        会话创建时间下界（YYYY-MM-DD 或 ISO）
  --until <date>        会话创建时间上界
  --top <n>             仅显示费用最高的 n 个会话（结果内运行中优先）
  --all                 包含没有用量记录的会话
  --priced-only         仅显示费用大于 0 的会话
  --title <text>        浏览器标题（默认 “DSH 会话费用 · 实时”）
  -h, --help            显示帮助

示例
  dsh-cost-live
  dsh-cost-live --interval 10 --model claude-sonnet-5-5
  dsh-cost-live --port 8080 --no-open
  dsh-cost-live --once --out out\\dsh-cost-live.html --open
  dsh-cost-live --watch --no-open

说明
  浏览器通过 file:/// 打开页面时不能执行任何命令；自动更新必须由本进程
  （HTTP 服务）或 --watch 后台任务提供。价格表默认包含 claude-sonnet-5-5。
`;

const VALUE_FLAGS = new Set([
  'port',
  'host',
  'interval',
  'out',
  'home',
  'pricing',
  'model',
  'workspace',
  'since',
  'until',
  'top',
  'title',
  'server-url',
]);
const BOOLEAN_FLAGS = new Set([
  'open',
  'no-open',
  'once',
  'watch',
  'auto-reload',
  'no-auto-reload',
  'all',
  'priced-only',
  'help',
]);

/** Parse `--key value`, `--key=value`, and boolean flags. */
function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h') {
      options.help = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数: ${arg}`);
    let name = arg.slice(2);
    let value;
    const equals = name.indexOf('=');
    if (equals !== -1) {
      value = name.slice(equals + 1);
      name = name.slice(0, equals);
    }
    if (name === 'help' || name === 'h') {
      options.help = true;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      if (value === undefined) {
        value = argv[index + 1];
        index += 1;
      }
      if (value === undefined) throw new Error(`选项 --${name} 需要一个值`);
      options[name] = value;
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      if (value !== undefined) throw new Error(`选项 --${name} 不带值`);
      options[name] = true;
      continue;
    }
    throw new Error(`未知选项 --${name}`);
  }
  return options;
}

/** Parse an integer within an inclusive range. */
function intInRange(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} 必须是 ${min}–${max} 的整数（收到 ${value}）`);
  }
  return parsed;
}

/** Build the shared report filter object. */
function reportOptionsFrom(options) {
  const reportOptions = {};
  if (options.home !== undefined) reportOptions.home = options.home;
  if (options.pricing !== undefined) reportOptions.pricingPath = options.pricing;
  if (options.model !== undefined) reportOptions.model = options.model;
  if (options.workspace !== undefined) reportOptions.workspace = options.workspace;
  if (options.since !== undefined) reportOptions.since = options.since;
  if (options.until !== undefined) reportOptions.until = options.until;
  if (options['priced-only'] === true) reportOptions.pricedOnly = true;
  if (options.all === true) reportOptions.includeEmpty = true;
  if (options.top !== undefined) reportOptions.top = intInRange(options.top, '--top', 1, 100000);
  return reportOptions;
}

/** Regenerate the standalone file forever (方案 C). */
async function runWatch({ outPath, intervalMs, autoReload, serverUrl, title, reportOptions, open }) {
  let stopped = false;
  let timer = null;
  let opened = false;
  let lastSignature = null;

  function cycle() {
    const started = Date.now();
    try {
      const report = collectLiveReport(reportOptions);
      const target = writeLiveSnapshot({
        outPath,
        report,
        intervalMs,
        mode: 'file',
        autoReload,
        serverUrl,
        title,
      });
      const elapsed = Math.max(1, Date.now() - started);
      const signature = `${report.summary.sessions}|${report.summary.costMicroCny}|${report.summary.totalTokens}`;
      const changed = lastSignature !== null && lastSignature !== signature;
      lastSignature = signature;
      const verb = changed ? '已更新' : '已刷新';
      console.log(
        `[${clockLabel()}] ${verb} ${target} · ${report.summary.sessions} 会话 · ${formatCny(report.summary.costCny)} · ${formatTokens(report.summary.totalTokens)} tokens (${elapsed}ms)`,
      );
      if (open && !opened) {
        opened = true;
        openBrowser(pathToFileURL(target).href);
      }
    } catch (error) {
      console.error(`[${clockLabel()}] 更新失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!stopped) timer = setTimeout(cycle, intervalMs);
  }

  console.log(`dsh-cost live watch · 每 ${Math.round(intervalMs / 1000)} 秒重建独立页面`);
  console.log(`  输出   ${outPath}`);
  console.log('  停止   Ctrl+C');
  cycle();

  return new Promise((resolvePromise) => {
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      console.log('\n已停止后台更新。');
      resolvePromise();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/** Entry point. */
async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`dsh-cost-live: ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (options.help === true) {
    process.stdout.write(HELP);
    return 0;
  }

  let intervalMs;
  let port;
  let top;
  try {
    intervalMs =
      options.interval === undefined
        ? DEFAULT_INTERVAL_MS
        : intInRange(options.interval, '--interval', MIN_INTERVAL_MS / 1000, 3600) * 1000;
    port = options.port === undefined ? DEFAULT_PORT : intInRange(options.port, '--port', 0, 65535);
    top = options.top === undefined ? undefined : intInRange(options.top, '--top', 1, 100000);
    parseDateBound(options.since, false);
    parseDateBound(options.until, true);
  } catch (error) {
    console.error(`dsh-cost-live: ${error.message}`);
    return 2;
  }
  if (options.once === true && options.watch === true) {
    console.error('dsh-cost-live: --once 与 --watch 不能同时使用');
    return 2;
  }

  const host = options.host ?? '127.0.0.1';
  if (typeof host !== 'string' || host.trim() === '') {
    console.error('dsh-cost-live: --host 不能为空');
    return 2;
  }
  const title = options.title ?? 'DSH 会话费用 · 实时';
  const outPath = resolve(options.out ?? DEFAULT_OUTPUT);
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const serverUrl = options['server-url'] ?? `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${port}/`;

  const reportOptions = reportOptionsFrom(options);
  if (top !== undefined) reportOptions.top = top;

  const wantsStandalone = options.once === true || options.watch === true;
  let open;
  if (options['no-open'] === true) open = false;
  else if (options.open === true) open = true;
  else open = !options.once;

  try {
    if (options.once === true || options.watch === true) {
      if (options.watch === true) {
        const autoReload = options['no-auto-reload'] !== true;
        await runWatch({ outPath, intervalMs, autoReload, serverUrl, title, reportOptions, open });
        return 0;
      }
      const report = collectLiveReport(reportOptions);
      const target = writeLiveSnapshot({
        outPath,
        report,
        intervalMs,
        mode: 'file',
        autoReload: options['auto-reload'] === true,
        serverUrl,
        title,
      });
      process.stdout.write(`HTML 已生成: ${target}\n`);
      process.stdout.write(
        `会话 ${report.summary.sessions} 个 · 总费用 ${formatCny(report.summary.costCny)} · Token ${formatTokens(report.summary.totalTokens)}\n`,
      );
      if (options['auto-reload'] === true) {
        process.stdout.write('页面每 ' + Math.round(intervalMs / 1000) + ' 秒自动重载；需配合 dsh-cost-live-watch.cmd 重建文件。\n');
      }
      if (open) openBrowser(pathToFileURL(target).href);
      return 0;
    }

    const live = await startLiveServer({
      host,
      port,
      intervalMs,
      reportOptions,
      open,
      title,
    });

    await new Promise((resolvePromise) => {
      const stop = async () => {
        process.stdout.write('\n正在停止实时服务…\n');
        try {
          await live.close();
        } catch {
          /* best effort */
        }
        resolvePromise();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return 0;
  } catch (error) {
    console.error(`dsh-cost-live: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  if (typeof code === 'number') process.exitCode = code;
});
