/**
 * Resolve one or more DSH data sources.
 *
 * A source is a `{ label, home }` pair. The dashboard normally watches the
 * local DSH home; the VMware mirror is just a second home whose `sessions/`
 * and `storages/session_projcache/` trees are refreshed by
 * `tools/sync-vm-dsh.ps1`.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { resolveHome } from './sessions.mjs';

/** Expand `~`, `~/...`, and relative paths against `baseDir`. */
export function expandSourcePath(value, baseDir = process.cwd()) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let text = value.trim();
  if (text === '~') text = homedir();
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = resolve(homedir(), text.slice(2));
  return isAbsolute(text) ? resolve(text) : resolve(baseDir, text);
}

/** Parse `label=path` or a bare path (label becomes sourceN). */
export function parseSourceSpec(spec, index = 0) {
  if (typeof spec !== 'string' || spec.trim() === '') throw new Error('empty --source value');
  const equals = spec.indexOf('=');
  if (equals === -1) return { label: `source${index + 1}`, home: spec.trim() };
  const label = spec.slice(0, equals).trim();
  return { label: label === '' ? `source${index + 1}` : label, home: spec.slice(equals + 1).trim() };
}

function uniqueLabel(label, used) {
  let result = label;
  let suffix = 2;
  while (used.has(result)) {
    result = `${label}#${suffix}`;
    suffix += 1;
  }
  used.add(result);
  return result;
}

/**
 * Build the source list from a JSON file, repeated `--source` values, and/or
 * the legacy single `--home`.
 *
 * `sources.json` shape:
 *   { "sources": [ { "label": "host", "home": "~/.dsh" },
 *                  { "label": "vm",   "home": "../.dsh-vm" } ] }
 * Relative homes resolve against the JSON file's directory.
 */
export function loadSources({ sources, sourcesPath, home, baseDir = process.cwd() } = {}) {
  const list = [];
  if (typeof sourcesPath === 'string' && sourcesPath !== '') {
    const file = resolve(sourcesPath);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`cannot read sources file ${file}: ${error.message}`);
    }
    const entries = Array.isArray(parsed) ? parsed : parsed.sources;
    if (!Array.isArray(entries) || entries.length === 0) throw new Error(`sources file ${file} has no sources`);
    const fileDir = dirname(file);
    entries.forEach((entry, index) => {
      if (entry === null || typeof entry !== 'object') throw new Error(`sources[${index}] must be an object`);
      const resolved = expandSourcePath(entry.home, fileDir);
      if (resolved === null) throw new Error(`sources[${index}].home is empty`);
      list.push({ label: String(entry.label ?? `source${index + 1}`).trim() || `source${index + 1}`, home: resolved });
    });
  }

  if (Array.isArray(sources)) {
    sources.forEach((spec, index) => {
      const parsed = parseSourceSpec(spec, index);
      const resolved = expandSourcePath(parsed.home, baseDir);
      if (resolved === null) throw new Error(`--source ${spec}: empty path`);
      list.push({ label: parsed.label, home: resolved });
    });
  }

  if (list.length === 0) list.push({ label: 'local', home: resolveHome(home) });

  const used = new Set();
  return list.map((source) => ({ ...source, label: uniqueLabel(source.label, used) }));
}

/** Human-readable "label: path" summary for logs and report headers. */
export function describeSources(sources) {
  return sources.map((source) => `${source.label}: ${source.home}`).join(' · ');
}