/**
 * Session activity: running vs completed, main session vs subagent.
 *
 * DSH persists the signals in its projection cache
 * (<DSH_HOME>/storages/session_projcache/sessions/<id>.json):
 *   rows.sessionStats.val.openStep          non-null while a step is in flight
 *   rows.turnBoundary.val.lastStepBoundary  `start` fallback when stats are absent
 *   rows.subagent.val.identity              present only for subagent sessions
 * The durable log header also carries `origin: "subagent"` (plus parentSession),
 * which still identifies a child session before its projection cache is written.
 *
 * Display order: running main session -> running subagent -> completed session.
 * Within one bucket the existing cost/time order stays as the tie-breaker.
 */

export const ACTIVITY_RUNNING_MAIN = 0;
export const ACTIVITY_RUNNING_SUBAGENT = 1;
export const ACTIVITY_COMPLETED = 2;

/** True when the projection reports an in-flight step (openStep != null). */
export function projectionIsRunning(projection) {
  if (projection === null || projection === undefined) return false;
  const stats = projection.sessionStats;
  // An explicit openStep (including null) is authoritative; only fall back to
  // turnBoundary when the cache predates sessionStats or omits the field.
  if (stats !== null && stats !== undefined && typeof stats === 'object' && stats.openStep !== undefined) {
    return stats.openStep !== null;
  }
  const boundary = projection.turnBoundary;
  if (boundary !== null && boundary !== undefined && typeof boundary === 'object') {
    return boundary.lastStepBoundary?.kind === 'start';
  }
  return false;
}

/** True when the session is a subagent (projection identity or log origin). */
export function isSubagentSession(meta, projection) {
  const identity = projection?.subagent?.identity;
  if (identity !== null && identity !== undefined && typeof identity === 'object') return true;
  return meta?.origin === 'subagent';
}

/** Normalize a raw `{ meta, projection }` analysis result into activity flags. */
export function sessionActivity(result) {
  return {
    running: projectionIsRunning(result?.projection),
    isSubagent: isSubagentSession(result?.meta, result?.projection),
  };
}

/** Priority bucket: 0 running main, 1 running subagent, 2 completed. */
export function activityRank(activity) {
  if (activity?.running !== true) return ACTIVITY_COMPLETED;
  return activity.isSubagent === true ? ACTIVITY_RUNNING_SUBAGENT : ACTIVITY_RUNNING_MAIN;
}

/** Human-readable state for tooltips / terminal details. */
export function activityLabel(activity) {
  if (activity?.running === true) return activity.isSubagent === true ? '运行中（子代理）' : '运行中（主会话）';
  return activity?.isSubagent === true ? '已完成（子代理）' : '已完成';
}

/**
 * Stable comparator: bucket first, then cost desc, then newest first.
 * `costMicroCny` / `createdAt` are optional so records and raw results can share it.
 */
export function compareActivity(a, b) {
  const rank = activityRank(a) - activityRank(b);
  if (rank !== 0) return rank;
  const cost = (b.costMicroCny ?? 0) - (a.costMicroCny ?? 0);
  if (cost !== 0) return cost;
  return (b.createdAt ?? 0) - (a.createdAt ?? 0);
}

/** Comparator for pipeline results shaped `{ meta, analysis }`. */
export function compareSessionResults(a, b) {
  return compareActivity(
    {
      ...sessionActivity(a),
      costMicroCny: a.analysis?.totals?.costMicroCny ?? 0,
      createdAt: a.meta?.createdAt ?? 0,
    },
    {
      ...sessionActivity(b),
      costMicroCny: b.analysis?.totals?.costMicroCny ?? 0,
      createdAt: b.meta?.createdAt ?? 0,
    },
  );
}

/** Stable in-place sort of pipeline results. */
export function sortSessionResults(results) {
  return results.sort(compareSessionResults);
}

/** Comparator for built session records (JSON/HTML output). */
export function compareSessionRecords(a, b) {
  return compareActivity(
    { running: a.running, isSubagent: a.isSubagent, costMicroCny: a.totals?.costMicroCny ?? 0, createdAt: a.createdAt ?? 0 },
    { running: b.running, isSubagent: b.isSubagent, costMicroCny: b.totals?.costMicroCny ?? 0, createdAt: b.createdAt ?? 0 },
  );
}

/** Stable in-place sort of built session records. */
export function sortSessionRecords(sessions) {
  return sessions.sort(compareSessionRecords);
}
