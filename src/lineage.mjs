/**
 * Session lineage: the parent session *name* behind a subagent session.
 *
 * DSH persists the relationship in the child's durable session header:
 * `origin: "subagent"` plus `parentSession: "session-<uuid>"`. The id in that
 * field keeps the `session-` prefix, while the log header id and the
 * projection-cache file name drop it; the on-disk directory keeps it. All
 * three spellings therefore have to match the same session.
 *
 * Names are resolved against the complete session set of the *same* source:
 * a parent skipped by the current day/model/workspace/top filter (or paged
 * away) still has to be named, but a parent that only exists in another DSH
 * home must never be used, because session ids collide across sources.
 *
 * Only the parent's title is a name. The id is shown separately by the
 * renderer and is never substituted for the name: a missing parent or an
 * untitled one resolves to `null` so the UI can show a localized placeholder.
 */
import { existsSync } from 'node:fs';
import { discoverSessions, readProjectionCache, readSession } from './sessions.mjs';

const SESSION_PREFIX = 'session-';

/**
 * Canonical session id: one leading `session-` removed.
 * @param {unknown} value - raw id (with or without the prefix).
 * @returns {string|null} canonical id, or null when empty/not a string.
 */
export function canonicalSessionId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const stripped = trimmed.startsWith(SESSION_PREFIX) ? trimmed.slice(SESSION_PREFIX.length) : trimmed;
  return stripped === '' ? null : stripped;
}

/**
 * Canonical id named by a session's `parentSession` header field.
 * @returns {string|null} parent id, or null for a main session.
 */
export function parentSessionIdOf(meta) {
  return canonicalSessionId(meta?.parentSession);
}

/** Trim a title down to a usable name, or null. */
function usableTitle(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Index every session of one home by both its directory id and its canonical
 * id, so `session-<id>` and `<id>` resolve to the same descriptor.
 */
function indexHome(home) {
  const index = new Map();
  for (const descriptor of discoverSessions({ home })) {
    for (const candidate of [descriptor.id, canonicalSessionId(descriptor.id)]) {
      if (candidate !== null && !index.has(candidate)) index.set(candidate, descriptor);
    }
  }
  return index;
}

/**
 * Title of one parent session: the projection cache is a small JSON file and
 * already holds the latest title, so it wins; a session without a cache (older
 * logs) is read from its durable log instead.
 */
function readParentTitle(home, descriptor) {
  const cacheId = canonicalSessionId(descriptor.id);
  if (cacheId !== null) {
    try {
      const projection = readProjectionCache(home, cacheId);
      const cached = usableTitle(projection?.title);
      if (cached !== null) return cached;
    } catch {
      /* fall through to the durable log */
    }
  }
  try {
    return usableTitle(readSession(descriptor, { events: false }).meta.title);
  } catch {
    return null;
  }
}

/**
 * Resolve the direct parent session of every subagent result.
 *
 * @param {object} options
 * @param {object[]} options.results - pipeline results shaped `{ meta, analysis }`.
 * @param {{label: string, home: string}[]} [options.sources] - configured sources.
 * @returns {Map<object, {parentSessionId: string, parentTitle: string|null, parentFound: boolean}>}
 *   keyed by the result `meta` object. Main sessions are absent.
 */
export function resolveSessionParents({ results = [], sources = [] } = {}) {
  const info = new Map();
  const homeByLabel = new Map();
  for (const source of sources) {
    if (source !== null && typeof source === 'object' && typeof source.label === 'string') {
      homeByLabel.set(source.label, source.home ?? null);
    }
  }

  // Everything this scan already parsed can name a parent for free; collect it
  // per home and remember which parents are still unknown.
  const titlesByHome = new Map();
  const parentsByHome = new Map();
  for (const result of results) {
    const meta = result?.meta ?? null;
    if (meta === null || typeof meta !== 'object') continue;
    const home =
      typeof meta.sourceHome === 'string' && meta.sourceHome !== ''
        ? meta.sourceHome
        : homeByLabel.get(meta.source) ?? null;
    if (typeof home !== 'string' || home === '') continue;
    let titles = titlesByHome.get(home);
    if (titles === undefined) {
      titles = new Map();
      titlesByHome.set(home, titles);
    }
    const title = usableTitle(meta.title);
    if (title !== null) {
      for (const id of [meta.id, meta.dirName]) {
        const canonical = canonicalSessionId(id);
        if (canonical !== null) titles.set(canonical, title);
      }
    }
    const parentSessionId = parentSessionIdOf(meta);
    if (parentSessionId === null) continue;
    let parents = parentsByHome.get(home);
    if (parents === undefined) {
      parents = new Map();
      parentsByHome.set(home, parents);
    }
    const metas = parents.get(parentSessionId) ?? [];
    metas.push(meta);
    parents.set(parentSessionId, metas);
  }

  for (const [home, parents] of parentsByHome) {
    const index = existsSync(home) ? indexHome(home) : null;
    const titles = titlesByHome.get(home) ?? new Map();
    for (const [parentSessionId, metas] of parents) {
      const descriptor = index?.get(parentSessionId) ?? null;
      let parentFound = descriptor !== null;
      let parentTitle = null;
      if (descriptor !== null) {
        parentTitle = titles.get(parentSessionId) ?? readParentTitle(home, descriptor);
      } else if (titles.has(parentSessionId)) {
        // Present in this scan but absent on disk (deleted meanwhile): the
        // parsed title still proves the parent existed for this report.
        parentFound = true;
        parentTitle = titles.get(parentSessionId);
      }
      for (const meta of metas) {
        info.set(meta, { parentSessionId, parentTitle, parentFound });
      }
    }
  }
  return info;
}
