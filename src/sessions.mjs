/**
 * Session discovery and durable-log reading.
 *
 * DSH stores one directory per session:
 *   <DSH_HOME>/sessions/<encoded-workspace>/<session-id>/session.v4.jsonl.zstd
 * The first line is the immutable `session` header; `session/title` events are
 * appended as the title evolves. The projection cache under
 * <DSH_HOME>/storages/session_projcache/sessions/<id>.json carries the same
 * header metadata plus DSH's own `tokenUsage` totals, which this tool uses for
 * optional cross-checks (never as the source of per-model truth).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isSubagentSession, projectionIsRunning } from './activity.mjs';
import { decompressZstdFrames, isZstd } from './zstd.mjs';

/** DSH home: explicit flag, then $DSH_HOME, then ~/.dsh. */
export function resolveHome(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit;
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') return process.env.DSH_HOME;
  return join(homedir(), '.dsh');
}

/** Parse a JSON-lines text into events, counting malformed lines. */
export function parseJsonl(text) {
  const events = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const value = JSON.parse(trimmed);
      if (value !== null && typeof value === 'object' && typeof value.type === 'string') events.push(value);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return { events, badLines };
}

/** Read the projection cache for one session id, or null when absent/invalid. */
export function readProjectionCache(home, id) {
  const file = join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const rows = parsed?.record?.rows;
    if (rows === null || typeof rows !== 'object') return null;
    return {
      file,
      title: typeof rows.title?.val === 'string' ? rows.title.val : null,
      tokenUsage: rows.tokenUsage?.val ?? null,
      modelSelection: rows.modelSelection?.val ?? null,
      // Runtime activity: openStep is non-null while a step is in flight and
      // subagent.identity exists only for child sessions. Both are optional, so
      // an older/partial cache simply falls back to "completed / main session".
      sessionStats: rows.sessionStats?.val ?? null,
      turnBoundary: rows.turnBoundary?.val ?? null,
      subagent: rows.subagent?.val ?? null,
    };
  } catch {
    return null;
  }
}

/** Enumerate session directories, optionally filtered by workspace path/name. */
export function discoverSessions({ home, workspace, since, until, id } = {}) {
  const root = join(home, 'sessions');
  if (!existsSync(root)) return [];
  const discovered = [];
  for (const workspaceDir of readdirSync(root, { withFileTypes: true })) {
    if (!workspaceDir.isDirectory()) continue;
    if (workspace !== undefined && !workspaceDir.name.toLowerCase().includes(workspace.toLowerCase())) continue;
    const wsPath = join(root, workspaceDir.name);
    for (const sessionDir of readdirSync(wsPath, { withFileTypes: true })) {
      if (!sessionDir.isDirectory()) continue;
      if (id !== undefined && !sessionDir.name.startsWith(id)) continue;
      const logPath = join(wsPath, sessionDir.name, 'session.v4.jsonl.zstd');
      if (!existsSync(logPath)) continue;
      const stat = statSync(logPath);
      discovered.push({
        home,
        id: sessionDir.name,
        dir: dirname(logPath),
        logPath,
        workspaceDir: workspaceDir.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  discovered.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (since === undefined && until === undefined) return discovered;
  // Creation time lives in the log header; read it lazily for filtered listings.
  return discovered.filter((descriptor) => {
    const meta = readSession(descriptor, { events: false }).meta;
    const t = meta.createdAt ?? descriptor.mtimeMs;
    if (since !== undefined && t < since) return false;
    if (until !== undefined && t > until) return false;
    return true;
  });
}

/**
 * Read one session's header, title, and (optionally) all events.
 * @returns {{meta: object, events: object[], badLines: number, projection: object|null}}
 */
export function readSession(descriptor, { events = true } = {}) {
  const buffer = readFileSync(descriptor.logPath);
  const decoded = isZstd(buffer) ? decompressZstdFrames(buffer) : { text: buffer.toString('utf8'), frames: 0, skipped: 0 };
  const parsed = parseJsonl(decoded.text);
  const header = parsed.events.find((event) => event.type === 'session') ?? null;
  const id = typeof header?.id === 'string' ? header.id : descriptor.id;
  const home = descriptor.home ?? dirname(dirname(dirname(dirname(descriptor.logPath))));
  const projection = readProjectionCache(home, id);
  let title = null;
  for (let index = parsed.events.length - 1; index >= 0; index -= 1) {
    const event = parsed.events[index];
    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      title = event.data.title;
      break;
    }
  }
  if (title === null || title.trim() === '') title = projection?.title ?? null;
  const meta = {
    id,
    title,
    cwd: typeof header?.cwd === 'string' ? header.cwd : null,
    createdAt: typeof header?.createdAt === 'number' ? header.createdAt : null,
    agentPreset: typeof header?.agentPreset === 'string' ? header.agentPreset : null,
    delegationDepth: typeof header?.delegationDepth === 'number' ? header.delegationDepth : null,
    // A subagent's durable header carries origin/parentSession even before its
    // projection cache exists; running is derived from the projection only.
    origin: typeof header?.origin === 'string' ? header.origin : null,
    parentSession: typeof header?.parentSession === 'string' ? header.parentSession : null,
    running: projectionIsRunning(projection),
    isSubagent: isSubagentSession(header, projection),
    workspaceDir: descriptor.workspaceDir,
    logPath: descriptor.logPath,
    dirName: descriptor.id,
    frames: decoded.frames,
    skippedFrames: decoded.skipped,
  };
  return { meta, events: events ? parsed.events : [], badLines: parsed.badLines, projection };
}

/** Resolve a user-supplied session id or unique prefix against discovered sessions. */
export function matchSession(sessions, query) {
  const idOf = (session) => session.id ?? session.dirName ?? '';
  const exact = sessions.filter((session) => idOf(session) === query);
  if (exact.length === 1) return { session: exact[0] };
  const prefixed = sessions.filter((session) => idOf(session).startsWith(query));
  if (prefixed.length === 1) return { session: prefixed[0] };
  if (prefixed.length === 0) return { error: `no session matches "${query}"` };
  return { error: `session prefix "${query}" is ambiguous: ${prefixed.map((s) => idOf(s)).join(', ')}` };
}

/** Basename of a log path, for diagnostics only. */
export function logName(session) {
  return basename(session.logPath);
}


