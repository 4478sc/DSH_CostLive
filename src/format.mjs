/** Terminal text helpers: East-Asian display width, truncation, alignment, dates. */

/** Display width in terminal cells (CJK/fullwidth/emoji count as 2). */
export function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const cp = char.codePointAt(0);
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Pad with spaces to `width` display cells. */
export function padEndDisplay(text, width) {
  const value = String(text);
  const missing = width - displayWidth(value);
  return missing > 0 ? value + ' '.repeat(missing) : value;
}

/** Pad on the left with spaces to `width` display cells. */
export function padStartDisplay(text, width) {
  const value = String(text);
  const missing = width - displayWidth(value);
  return missing > 0 ? ' '.repeat(missing) + value : value;
}

/** Truncate to `width` display cells, appending an ellipsis when shortened. */
export function truncateDisplay(text, width) {
  const value = String(text);
  if (displayWidth(value) <= width) return value;
  if (width <= 1) return '…'.slice(0, width);
  let out = '';
  let used = 0;
  for (const char of value) {
    const cost = isWide(char.codePointAt(0)) ? 2 : 1;
    if (used + cost > width - 1) break;
    out += char;
    used += cost;
  }
  return `${out}…`;
}

/** Local "YYYY-MM-DD HH:mm" timestamp. */
export function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Local "YYYY-MM-DD" date. */
export function formatDate(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Percent text with one decimal; null renders as an em dash. */
export function formatPercent(ratio, digits = 1) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/**
 * Render a fixed-width table.
 * @param headers - header cells.
 * @param rows - cell arrays.
 * @param aligns - 'l' | 'r' per column.
 * @param maxWidths - optional per-column cap; text is truncated with an ellipsis.
 */
export function renderTable(headers, rows, aligns, maxWidths = []) {
  const widths = headers.map((header, index) => {
    let width = displayWidth(header);
    for (const row of rows) width = Math.max(width, displayWidth(row[index] ?? ''));
    const cap = maxWidths[index];
    return cap === undefined ? width : Math.min(width, cap);
  });
  const line = (cells) =>
    cells
      .map((cell, index) => {
        const text = truncateDisplay(cell ?? '', widths[index]);
        return aligns[index] === 'r' ? padStartDisplay(text, widths[index]) : padEndDisplay(text, widths[index]);
      })
      .join('  ')
      .replace(/\s+$/u, '');
  const headerLine = line(headers);
  const rule = widths.map((width) => '─'.repeat(width)).join('  ');
  return [headerLine, rule, ...rows.map((row) => line(row))].join('\n');
}
