export const TERMINAL_RUN_STATUSES = Object.freeze(new Set(['success', 'partial', 'failed', 'cancelled', 'blocked', 'interrupted', 'waiting_auth']))
export const ACTIVE_PUBLISH_STATUSES = Object.freeze(new Set(['preview', 'queued', 'committing']))

export function retentionExpiry(run, now = new Date()) {
  if (run?.retention_until) return new Date(run.retention_until)
  const days = run?.status === 'success' ? 7 : 30
  return new Date(new Date(run?.finished_at || run?.created_at).getTime() + days * 86_400_000)
}

export function selectRetentionCandidates(runs = [], now = new Date()) {
  const referenced = new Set(runs.map(run => run?.parent_run_id).filter(Boolean))
  return runs.filter(run => {
    if (!run || !TERMINAL_RUN_STATUSES.has(run.status) || Number(run.pinned) === 1 || run.pinned === true || referenced.has(run.id) || ACTIVE_PUBLISH_STATUSES.has(run.publish_status)) return false
    const expiresAt = retentionExpiry(run, now)
    return !Number.isNaN(expiresAt.getTime()) && expiresAt <= now
  })
}
