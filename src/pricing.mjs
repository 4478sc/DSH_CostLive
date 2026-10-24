/**
 * Price table loading, model-id normalization, and CNY cost arithmetic.
 *
 * All rates are CNY per `unitTokens` tokens (1,000,000 by default). Costs are
 * accumulated as integer "micro-CNY" (1e-6 CNY) so that replacing a streamed
 * usage sample with its final sample is exact: costMicro = tokens * rate,
 * because tokens * (CNY / 1e6 tokens) == 1e6 * CNY.
 *
 * A model entry may carry a two-tier tariff: the four top-level rates are the
 * DEFAULT (off-peak / 谷值) prices, an optional `peak` record holds the doubled
 * peak rates, and `peakHours` says when the peak tier applies. Entries without
 * `peak` are flat, which keeps every older price document valid.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PRICING_PATH = join(HERE, '..', 'config', 'pricing.json');

/**
 * Peak windows for the two-tier tariff: Beijing time, Monday to Friday,
 * 09:00-12:00 and 14:00-18:00. Everything else (weekends, nights, listed
 * holidays) is billed at the default off-peak rates.
 */
export const DEFAULT_PEAK_HOURS = Object.freeze({
  timeZone: 'Asia/Shanghai',
  weekdays: Object.freeze([1, 2, 3, 4, 5]),
  windows: Object.freeze(['09:00-12:00', '14:00-18:00']),
  holidays: Object.freeze([]),
});

/** Built-in table, identical to config/pricing.json; used when the file is absent. */
export const DEFAULT_PRICING = Object.freeze({
  currency: 'CNY',
  unitTokens: 1000000,
  models: Object.freeze({
    'claude-sonnet-5-5': Object.freeze({
      input: 2.3,
      output: 11.5,
      cacheWrite: 2.875,
      cacheRead: 0.23,
    }),
    // DeepSeek V4.1 Flash (served as `deepseek-flash`). Default = 谷值: cache
    // miss 0.15 / cache hit 0.003 / output 0.6 CNY per 1M; peak = doubled.
    // A cache write is billed as a cache miss, so cacheWrite mirrors `input`.
    'deepseek-v4.1-flash': Object.freeze({
      input: 0.15,
      output: 0.6,
      cacheWrite: 0.15,
      cacheRead: 0.003,
      peak: Object.freeze({ input: 0.3, output: 1.2, cacheWrite: 0.3, cacheRead: 0.006 }),
      peakHours: DEFAULT_PEAK_HOURS,
    }),
  }),
  aliases: Object.freeze({
    'claude-sonnet-5.5': 'claude-sonnet-5-5',
    'claude-sonnet-5.5-20260101': 'claude-sonnet-5-5',
    // Official server-side name plus the retired names DeepSeek still accepts.
    'deepseek-flash': 'deepseek-v4.1-flash',
    'deepseek-v4-flash': 'deepseek-v4.1-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-v4.1-flash',
  }),
});

const PRICE_FIELDS = ['input', 'output', 'cacheWrite', 'cacheRead'];
/** `Intl` weekday short names in ISO order (Monday = 1). */
const WEEKDAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Validate one four-field rate record and return a plain copy. */
function rateRecord(where, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`pricing: ${where} must be an object`);
  }
  const out = {};
  for (const field of PRICE_FIELDS) {
    const rate = value[field];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
      throw new Error(`pricing: ${where}.${field} must be a non-negative finite number`);
    }
    out[field] = rate;
  }
  return out;
}

/** Validate a peak-window description, filling in the DeepSeek defaults. */
function peakHoursRecord(where, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`pricing: ${where} must be an object`);
  }
  const timeZone = typeof value.timeZone === 'string' && value.timeZone.trim() !== '' ? value.timeZone.trim() : DEFAULT_PEAK_HOURS.timeZone;
  const weekdays = value.weekdays ?? DEFAULT_PEAK_HOURS.weekdays;
  if (!Array.isArray(weekdays) || weekdays.length === 0 || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new Error(`pricing: ${where}.weekdays must be a non-empty array of ISO weekday numbers 1-7`);
  }
  const windows = value.windows ?? DEFAULT_PEAK_HOURS.windows;
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new Error(`pricing: ${where}.windows must be a non-empty array of "HH:MM-HH:MM" ranges`);
  }
  const ranges = windows.map((text) => {
    const match = typeof text === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/u.exec(text.trim()) : null;
    if (match === null) throw new Error(`pricing: ${where}.windows entries must look like "09:00-12:00"`);
    return text.trim();
  });
  const holidays = value.holidays ?? [];
  if (!Array.isArray(holidays) || holidays.some((day) => typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(day))) {
    throw new Error(`pricing: ${where}.holidays must be an array of YYYY-MM-DD strings`);
  }
  return { timeZone, weekdays: [...weekdays].sort((a, b) => a - b), windows: ranges, holidays: [...holidays] };
}

/** Validate and normalize a pricing document. */
export function normalizePricing(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('pricing: document must be an object');
  }
  const currency = typeof raw.currency === 'string' && raw.currency.trim() !== '' ? raw.currency.trim() : 'CNY';
  const unitTokens = raw.unitTokens ?? 1000000;
  if (!Number.isInteger(unitTokens) || unitTokens <= 0) {
    throw new Error('pricing: unitTokens must be a positive integer');
  }
  if (raw.models === null || typeof raw.models !== 'object' || Array.isArray(raw.models) || Object.keys(raw.models).length === 0) {
    throw new Error('pricing: models must be a non-empty object');
  }
  const models = {};
  for (const [id, price] of Object.entries(raw.models)) {
    const key = id.toLowerCase();
    const entry = rateRecord(`models["${id}"]`, price);
    if (price.peak !== undefined) {
      entry.peak = rateRecord(`models["${id}"].peak`, price.peak);
      entry.peakHours = price.peakHours === undefined ? peakHoursRecord(`models["${id}"].peakHours`, {}) : peakHoursRecord(`models["${id}"].peakHours`, price.peakHours);
    } else if (price.peakHours !== undefined) {
      throw new Error(`pricing: models["${id}"].peakHours requires a peak rate record`);
    }
    models[key] = entry;
  }
  const aliases = {};
  if (raw.aliases !== undefined) {
    if (raw.aliases === null || typeof raw.aliases !== 'object' || Array.isArray(raw.aliases)) {
      throw new Error('pricing: aliases must be an object');
    }
    for (const [from, to] of Object.entries(raw.aliases)) {
      if (typeof to !== 'string') throw new Error(`pricing: aliases["${from}"] must be a model id string`);
      aliases[from.toLowerCase()] = to.toLowerCase();
    }
  }
  return { currency, unitTokens, models, aliases };
}

/** Load and validate a pricing document; a missing file falls back to the built-in table. */
export function loadPricing(path = DEFAULT_PRICING_PATH) {
  try {
    return normalizePricing(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error && error.code === 'ENOENT') return normalizePricing(DEFAULT_PRICING);
    if (error instanceof SyntaxError) throw new Error(`pricing: ${path} is not valid JSON: ${error.message}`);
    throw error;
  }
}

/** Canonical-ish model id: lowercase, provider prefix and vendor suffix removed. */
export function normalizeModelId(model) {
  let id = String(model ?? '').trim().toLowerCase();
  if (id === '') return '';
  const slash = id.lastIndexOf('/');
  if (slash !== -1) id = id.slice(slash + 1);
  return id;
}

/** Candidate ids for one model, most specific first. */
function candidatesFor(model, pricing) {
  const base = normalizeModelId(model);
  if (base === '') return [];
  const out = [];
  const push = (id) => {
    if (id && !out.includes(id)) out.push(id);
  };
  push(base);
  push(pricing.aliases[base]);
  const noDate = base
    .replace(/-\d{4}-\d{2}-\d{2}$/u, '')
    .replace(/-\d{8}$/u, '')
    .replace(/-(latest|stable|preview)$/u, '');
  push(noDate);
  push(pricing.aliases[noDate]);
  return out;
}

/**
 * Resolve one model id to a price entry.
 * @returns {{key: string, price: {input:number,output:number,cacheWrite:number,cacheRead:number}, matched: string} | null}
 */
export function resolvePrice(model, pricing) {
  const candidates = candidatesFor(model, pricing);
  for (const id of candidates) {
    const exact = pricing.models[id];
    if (exact !== undefined) return { key: id, price: exact, matched: 'exact' };
  }
  let best = null;
  for (const [id, price] of Object.entries(pricing.models)) {
    if (!id.endsWith('*')) continue;
    const prefix = id.slice(0, -1);
    if (prefix === '') continue;
    if (!candidates.some((candidate) => candidate.startsWith(prefix))) continue;
    if (best === null || prefix.length > best.prefix.length) best = { key: id, price, prefix };
  }
  return best === null ? null : { key: best.key, price: best.price, matched: 'prefix' };
}

/** Cached `Intl` formatters, one per zone: formatting dominates a peak check. */
const ZONE_FORMATTERS = new Map();
/** Parsed minute ranges per peak-window record. */
const WINDOW_RANGES = new WeakMap();

/** Turn "09:00-12:00" strings into minute-of-day ranges, once per window record. */
function minuteRanges(window) {
  let ranges = WINDOW_RANGES.get(window);
  if (ranges === undefined) {
    ranges = (window.windows ?? []).map((text) => {
      const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/u.exec(text);
      return match === null
        ? { start: 0, end: 0 }
        : { start: Number(match[1]) * 60 + Number(match[2]), end: Number(match[3]) * 60 + Number(match[4]) };
    });
    WINDOW_RANGES.set(window, ranges);
  }
  return ranges;
}

/** Wall-clock parts of one instant inside a zone. */
function zonedParts(timeZone, timeMs) {
  let formatter = ZONE_FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    ZONE_FORMATTERS.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(timeMs));
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    weekday: WEEKDAY_INDEX[pick('weekday')] ?? 1,
    date: `${pick('year')}-${pick('month')}-${pick('day')}`,
    minutes: Number(pick('hour')) * 60 + Number(pick('minute')),
  };
}

/**
 * Whether one sample falls in a model's peak tier. Flat entries (no `peak`) and
 * samples without a usable timestamp take the default off-peak rates, so an
 * unknown clock never inflates a bill.
 */
export function isPeak(price, timeMs) {
  if (price.peak === undefined) return false;
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs)) return false;
  const window = price.peakHours ?? DEFAULT_PEAK_HOURS;
  const parts = zonedParts(window.timeZone, timeMs);
  if (!window.weekdays.includes(parts.weekday)) return false;
  if (window.holidays.includes(parts.date)) return false;
  return minuteRanges(window).some((range) =>
    range.start <= range.end ? parts.minutes >= range.start && parts.minutes < range.end : parts.minutes >= range.start || parts.minutes < range.end,
  );
}

/** The four rates that apply to one sample under one price entry. */
export function priceAt(price, timeMs) {
  const source = isPeak(price, timeMs) ? price.peak : price;
  return { input: source.input, output: source.output, cacheWrite: source.cacheWrite, cacheRead: source.cacheRead };
}

/**
 * Integer micro-CNY for one usage bucket set under one price.
 * @param buckets - the four token buckets.
 * @param price - a resolved price entry (flat or two-tier).
 * @param [timeMs] - sample timestamp selecting the default vs peak tier.
 */
export function costMicroCny(buckets, price, timeMs) {
  const rate = priceAt(price, timeMs);
  return Math.round(
    buckets.uncachedInputTokens * rate.input +
      buckets.outputTokens * rate.output +
      buckets.cacheWriteTokens * rate.cacheWrite +
      buckets.cacheReadTokens * rate.cacheRead,
  );
}

/** Floating-point CNY for one usage bucket set under one price. */
export function costCny(buckets, price, timeMs) {
  return costMicroCny(buckets, price, timeMs) / 1e6;
}

/** Zero bucket record. */
export function zeroBuckets() {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** Add bucket `b` into `target` in place and return target. */
export function addBuckets(target, b) {
  target.uncachedInputTokens += b.uncachedInputTokens;
  target.outputTokens += b.outputTokens;
  target.cacheReadTokens += b.cacheReadTokens;
  target.cacheWriteTokens += b.cacheWriteTokens;
  return target;
}

/** Sum of the three prompt-side billed buckets. */
export function billedInputTokens(buckets) {
  return buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
}

/** Locale-grouped integer token text. */
export function formatTokens(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

/**
 * Human CNY text with adaptive precision. Micro amounts stay visible instead of
 * collapsing to "0.00"; amounts at or above one yuan get four decimals.
 */
export function formatCny(value) {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 4 : 6;
  return `¥${value.toFixed(digits)}`;
}

/** One-line rate description, e.g. "in 2.3 / out 11.5 / cacheW 2.875 / cacheR 0.23 ¥/1M". */
export function describePrice(price) {
  const base = `in ${price.input} / out ${price.output} / cacheW ${price.cacheWrite} / cacheR ${price.cacheRead} ${'¥'}/1M`;
  if (price.peak === undefined) return base;
  const peak = price.peak;
  return `${base}（谷值）· 峰值 in ${peak.input} / out ${peak.output} / cacheW ${peak.cacheWrite} / cacheR ${peak.cacheRead} ¥/1M`;
}

/**
 * Human summary of the hours a two-tier price is charged at its peak rates,
 * e.g. "Asia/Shanghai 周一至周五 09:00-12:00、14:00-18:00".
 */
export function describePeakHours(price) {
  if (price.peak === undefined) return null;
  const window = price.peakHours ?? DEFAULT_PEAK_HOURS;
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const days = window.weekdays;
  const isRun = days.every((day, index) => index === 0 || day === days[index - 1] + 1);
  const dayText = isRun && days.length > 1 ? `${names[days[0] - 1]}至${names[days[days.length - 1] - 1]}` : days.map((day) => names[day - 1]).join('、');
  const windows = (window.windows ?? []).join('、');
  const holidays = window.holidays.length === 0 ? '' : `；${window.holidays.length} 个节假日按谷值计`;
  return `${window.timeZone} ${dayText} ${windows}${holidays}`;
}
