#!/usr/bin/env node
/**
 * README parity check.
 *
 * README.md (Chinese) and README.en.md (English) are two translations of the
 * same document. Prose cannot be compared, but the structure can: every
 * section must exist in both files, in the same order, with the same level,
 * and the same number of code blocks, tables and images. That catches the
 * usual failure mode of a translation that quietly drops or adds a section.
 *
 *   node tools/check-readme-parity.mjs [--root <dir>] [--files a.md,b.md]
 *
 * Exit code 0 when the structures match, 1 when they differ (the diff is
 * printed), 2 when a file is missing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, files: ['README.md', 'README.en.md'] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') { options.root = resolve(argv[i + 1] ?? options.root); i += 1; }
    else if (arg === '--files') { options.files = String(argv[i + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean); i += 1; }
    else if (arg === '--help' || arg === '-h') { options.help = true; }
    else throw new Error('unknown argument: ' + arg);
  }
  return options;
}

/** Structural fingerprint of one markdown document. */
export function readmeOutline(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const headings = [];
  const headingsWithText = [];
  let fences = 0;
  let tables = 0;
  let images = 0;
  let inFence = false;

  for (const line of lines) {
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      fences += 1;
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      headings.push(heading[1].length);
      headingsWithText.push({ level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    // A table separator line is "|---|:--:|"; counting it counts one table.
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('|')) {
      tables += 1;
      continue;
    }
    const found = line.match(/!\[[^\]]*\]\([^)]*\)/g);
    if (found) images += found.length;
  }

  return {
    headings,
    headingsWithText,
    fences: Math.ceil(fences / 2),
    tables,
    images,
  };
}

function summarise(name, outline) {
  const perLevel = {};
  for (const level of outline.headings) perLevel['h' + level] = (perLevel['h' + level] ?? 0) + 1;
  const levels = Object.keys(perLevel).sort().map((key) => key + '=' + perLevel[key]).join(' ');
  return `${name}: ${outline.headings.length} headings (${levels}), ${outline.fences} code blocks, ${outline.tables} tables, ${outline.images} images`;
}

function describeHeading(heading) {
  return 'h' + heading.level + ' ' + heading.text;
}

export function compareOutlines(a, b) {
  const problems = [];
  if (a.headings.length !== b.headings.length) {
    problems.push(`heading count differs: ${a.headings.length} vs ${b.headings.length}`);
  }
  const max = Math.max(a.headings.length, b.headings.length);
  for (let i = 0; i < max; i += 1) {
    const left = a.headingsWithText[i];
    const right = b.headingsWithText[i];
    if (left === undefined) { problems.push(`section #${i + 1} missing on the other side (expected "${describeHeading(right)}")`); continue; }
    if (right === undefined) { problems.push(`section #${i + 1} missing on the other side (expected "${describeHeading(left)}")`); continue; }
    if (left.level !== right.level) {
      problems.push(`section #${i + 1} level differs: "${describeHeading(left)}" vs "${describeHeading(right)}"`);
    }
  }
  if (a.fences !== b.fences) problems.push(`code blocks differ: ${a.fences} vs ${b.fences}`);
  if (a.tables !== b.tables) problems.push(`tables differ: ${a.tables} vs ${b.tables}`);
  if (a.images !== b.images) problems.push(`images differ: ${a.images} vs ${b.images}`);
  return problems;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(error.message + '\n');
    return 2;
  }
  if (options.help) {
    process.stdout.write('usage: check-readme-parity.mjs [--root <dir>] [--files a.md,b.md]\n');
    return 0;
  }
  if (options.files.length !== 2) {
    process.stderr.write('check-readme-parity: expected exactly two files\n');
    return 2;
  }

  const read = (name) => {
    try {
      return readFileSync(join(options.root, name), 'utf8');
    } catch (error) {
      process.stderr.write(`check-readme-parity: cannot read ${name}: ${error.message}\n`);
      return null;
    }
  };

  const [first, second] = options.files;
  const leftText = read(first);
  const rightText = read(second);
  if (leftText === null || rightText === null) return 2;

  const left = readmeOutline(leftText);
  const right = readmeOutline(rightText);
  const problems = compareOutlines(left, right);

  process.stdout.write(summarise(first, left) + '\n');
  process.stdout.write(summarise(second, right) + '\n');

  if (problems.length === 0) {
    process.stdout.write(`ok: ${first} and ${second} have the same structure\n`);
    return 0;
  }
  process.stdout.write('\nmismatch:\n');
  for (const problem of problems) process.stdout.write('  - ' + problem + '\n');
  process.stdout.write('\nsections in ' + first + ':\n');
  left.headingsWithText.forEach((heading, index) => process.stdout.write('  ' + String(index + 1).padStart(2) + '. ' + describeHeading(heading) + '\n'));
  process.stdout.write('\nsections in ' + second + ':\n');
  right.headingsWithText.forEach((heading, index) => process.stdout.write('  ' + String(index + 1).padStart(2) + '. ' + describeHeading(heading) + '\n'));
  return 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
