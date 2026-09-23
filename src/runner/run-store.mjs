import crypto from 'node:crypto'

const JSON_FIELDS = new Set(['workflow_snapshot', 'config_snapshot', 'rule_snapshot', 'strategy_snapshot', 'summary', 'artifact_manifest', 'script_snapshot', 'checkpoint'])

function json(value, fallback = {}) {
  return JSON.stringify(value === undefined || value === null ? fallback : value)
}

function parseRow(row) {
  if (!row) return null
  const result = { ...row }
  for (const field of JSON_FIELDS) {
    if (field in result && typeof result[field] === 'string') {
      try { result[field] = JSON.parse(result[field]) } catch { result[field] = {} }
    }
  }
  return result
}

function iso(value) {
  return typeof value === 'function' ? value() : new Date(value || Date.now()).toISOString()
}

function safeStatus(status) {
  return status || 'queued'
}

export function createRunStore({ db, client = null, workerId = `worker-${process.pid}`, now = () => new Date().toISOString(), lease = () => true } = {}) {
  if (!db && !client) throw new TypeError('db or client is required')
  if (!db) return createRemoteRunStore({ client, workerId, now })

  function getRun(id) { return parseRow(db.prepare('SELECT * FROM collection_runs WHERE id=?').get(id)) }
  function updateRun(id, patch) {
    const entries = Object.entries(patch).filter(([key]) => key !== 'id' && key in (getRun(id) || {}))
    if (!entries.length) return getRun(id)
    const columns = entries.map(([key]) => `${key}=?`).join(',')
    const values = entries.map(([key, value]) => JSON_FIELDS.has(key) ? json(value) : value)
    db.prepare(`UPDATE collection_runs SET ${columns},updated_at=? WHERE id=?`).run(...values, iso(now), id)
    return getRun(id)
  }

  return Object.freeze({
    async createRun({ id = crypto.randomUUID(), workflowId = null, runKind = 'workflow', scriptId = null, workflowSnapshot = {}, configSnapshot = {}, ruleSnapshot = {}, strategySnapshot = {}, parentRunId = null, retentionUntil = null } = {}) {
      const created = iso(now)
      db.prepare(`INSERT INTO collection_runs(id,workflow_id,run_kind,script_id,workflow_snapshot,status,config_snapshot,rule_snapshot,strategy_snapshot,parent_run_id,artifact_manifest,retention_until,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, workflowId, runKind, scriptId, json(workflowSnapshot), 'queued', json(configSnapshot), json(ruleSnapshot), json(strategySnapshot), parentRunId, '{}', retentionUntil, created, created)
      return getRun(id)
    },
    async getRun(id) { return getRun(id) },
    async listRuns({ status = null, limit = 100 } = {}) {
      const rows = status ? db.prepare('SELECT * FROM collection_runs WHERE status=? ORDER BY created_at DESC LIMIT ?').all(status, limit) : db.prepare('SELECT * FROM collection_runs ORDER BY created_at DESC LIMIT ?').all(limit)
      return rows.map(parseRow)
    },
    async claimNextRun({ leaseSeconds = 120 } = {}) {
      const nowValue = iso(now)
      const leaseUntil = new Date(new Date(nowValue).getTime() + leaseSeconds * 1000).toISOString()
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`UPDATE collection_runs SET status='interrupted',finished_at=?,lease_until=NULL,updated_at=?,summary=json_set(summary,'$.recovery','lease_expired') WHERE status='running' AND lease_until IS NOT NULL AND lease_until<=?`).run(nowValue, nowValue, nowValue)
        const active = db.prepare(`SELECT 1 FROM collection_runs WHERE status='running' AND lease_until IS NOT NULL AND lease_until>? LIMIT 1`).get(nowValue)
        if (active) { db.exec('COMMIT'); return null }
        const row = db.prepare(`SELECT id FROM collection_runs
          WHERE status IN ('queued','retrying')
          ORDER BY created_at,id LIMIT 1`).get()
        if (!row) { db.exec('COMMIT'); return null }
        db.prepare(`UPDATE collection_runs SET status='running',worker_id=?,lease_until=?,heartbeat_at=?,started_at=COALESCE(started_at,?),updated_at=? WHERE id=?`).run(workerId, leaseUntil, nowValue, nowValue, nowValue, row.id)
        db.exec('COMMIT')
        return getRun(row.id)
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    async claimRunById(runId, { leaseSeconds = 120 } = {}) {
      const nowValue = iso(now)
      const leaseUntil = new Date(new Date(nowValue).getTime() + leaseSeconds * 1000).toISOString()
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`UPDATE collection_runs SET status='interrupted',finished_at=?,lease_until=NULL,updated_at=?,summary=json_set(summary,'$.recovery','lease_expired') WHERE status='running' AND lease_until IS NOT NULL AND lease_until<=?`).run(nowValue, nowValue, nowValue)
        const active = db.prepare(`SELECT 1 FROM collection_runs WHERE status='running' AND lease_until IS NOT NULL AND lease_until>? LIMIT 1`).get(nowValue)
        if (active) { db.exec('COMMIT'); return null }
        const result = db.prepare(`UPDATE collection_runs SET status='running',worker_id=?,lease_until=?,heartbeat_at=?,started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND status IN ('queued','retrying')`).run(workerId, leaseUntil, nowValue, nowValue, nowValue, runId)
        if (!result.changes) { db.exec('COMMIT'); return null }
        db.exec('COMMIT')
        return getRun(runId)
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    async heartbeat(runId, { leaseSeconds = 120 } = {}) {
      if (!lease()) return false
      const nowValue = iso(now)
      const leaseUntil = new Date(new Date(nowValue).getTime() + leaseSeconds * 1000).toISOString()
      const result = db.prepare(`UPDATE collection_runs SET lease_until=?,heartbeat_at=?,updated_at=? WHERE id=? AND status='running' AND worker_id=? AND lease_until>?`).run(leaseUntil, nowValue, nowValue, runId, workerId, nowValue)
      return result.changes === 1
    },
    async assertLease(runId) {
      const run = getRun(runId)
      return Boolean(lease() && run?.status === 'running' && run.worker_id === workerId && run.lease_until && run.lease_until > iso(now))
    },
    async recoverExpiredRuns() {
      const nowValue = iso(now)
      const result = db.prepare(`UPDATE collection_runs SET status='interrupted',finished_at=?,updated_at=?,summary=json_set(summary,'$.recovery','lease_expired') WHERE status='running' AND lease_until IS NOT NULL AND lease_until<=?`).run(nowValue, nowValue, nowValue)
      return result.changes
    },
    async updateRun(id, patch) { return updateRun(id, patch) },
    async finishRun(id, status, summary = {}) { return updateRun(id, { status: safeStatus(status), summary, finished_at: iso(now), lease_until: null, heartbeat_at: iso(now) }) },
    async markInterrupted(id, reason = 'lease_lost') { return updateRun(id, { status: 'interrupted', summary: { recovery: reason }, finished_at: iso(now), lease_until: null }) },
    async markStartFailed(id, message = 'worker_start_failed') { return updateRun(id, { status: 'failed', summary: { recovery: 'worker_start_failed', error_code: 'WORKER_START_FAILED', error_message: message }, finished_at: iso(now), lease_until: null }) },
    async createStepRun({ runId, stepKey, scriptSnapshot = {}, attempt = 1, status = 'running', inputHash = null } = {}) {
      const id = crypto.randomUUID()
      const created = iso(now)
      const started = status === 'running' ? created : null
      db.prepare(`INSERT INTO collection_step_runs(id,run_id,step_key,script_snapshot,attempt,status,started_at,input_hash,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, runId, stepKey, json(scriptSnapshot), attempt, status, started, inputHash, created, created)
      return parseRow(db.prepare('SELECT * FROM collection_step_runs WHERE id=?').get(id))
    },
    async finishStepRun(id, patch = {}) {
      const existing = db.prepare('SELECT * FROM collection_step_runs WHERE id=?').get(id)
      if (!existing) throw new Error('step run not found')
      const values = Object.entries(patch).filter(([key]) => key !== 'id' && key in existing)
      if (!values.length) return parseRow(existing)
      const columns = values.map(([key]) => `${key}=?`).join(',')
      const args = values.map(([key, value]) => JSON_FIELDS.has(key) ? json(value) : value)
      db.prepare(`UPDATE collection_step_runs SET ${columns},updated_at=? WHERE id=?`).run(...args, iso(now), id)
      return parseRow(db.prepare('SELECT * FROM collection_step_runs WHERE id=?').get(id))
    },
    async listStepRuns(runId) { return db.prepare('SELECT * FROM collection_step_runs WHERE run_id=? ORDER BY step_key,attempt').all(runId).map(parseRow) },
    async getStepRuns(runId, stepKey) { return db.prepare('SELECT * FROM collection_step_runs WHERE run_id=? AND step_key=? ORDER BY attempt').all(runId, stepKey).map(parseRow) },
    async cancelRun(id) { return updateRun(id, { status: 'cancelled', finished_at: iso(now), lease_until: null }) }
  })
}

function createRemoteRunStore({ client, workerId, now }) {
  const first = value => Array.isArray(value) ? value[0] : value
  const rows = value => Array.isArray(value?.data) ? value.data : value?.data ? [value.data] : Array.isArray(value) ? value : []
  return Object.freeze({
    async createRun(input) {
      const rpc = input.runKind === 'single_script' ? 'create_collection_script_run' : 'create_collection_run'
      const payload = input.runKind === 'single_script'
        ? { p_script_id: input.scriptId, p_config_override: input.configSnapshot || {}, p_input_artifacts: input.configSnapshot?.input_artifacts || [], p_rule_snapshot: input.ruleSnapshot || {}, p_strategy_snapshot: input.strategySnapshot || {}, p_parent_run_id: input.parentRunId || null }
        : { p_workflow_id: input.workflowId, p_config_override: input.configSnapshot || {}, p_rule_snapshot: input.ruleSnapshot || {}, p_strategy_snapshot: input.strategySnapshot || {}, p_parent_run_id: input.parentRunId || null }
      return rows(await client.rpc(rpc, payload))[0] || null
    },
    async getRun(id) { return (await client.get('collection_runs', id)).data },
    async claimNextRun({ leaseSeconds = 120 } = {}) { return rows(await client.rpc('claim_collection_run', { p_worker_id: workerId, p_lease_seconds: leaseSeconds }))[0] || null },
    async claimRunById(runId, { leaseSeconds = 120 } = {}) { return rows(await client.rpc('claim_collection_run_by_id', { p_run_id: runId, p_worker_id: workerId, p_lease_seconds: leaseSeconds }))[0] || null },
    async heartbeat(runId, { leaseSeconds = 120 } = {}) { const result = await client.rpc('heartbeat_collection_run', { p_run_id: runId, p_worker_id: workerId, p_lease_seconds: leaseSeconds }); return result?.data === true || result?.data?.[0] === true },
    async assertLease(runId) { const run = await this.getRun(runId); return Boolean(run?.status === 'running' && run.worker_id === workerId && new Date(run.lease_until).getTime() > new Date(now()).getTime()) },
    async listRuns(options) { return rows(await client.list('collection_runs', options)) },
    async updateRun(id, patch) { await client.patch('collection_runs', [{ column: 'id', operator: 'eq', value: id }], patch); return this.getRun(id) },
    async finishRun(id, status, summary) { return this.updateRun(id, { status, summary, finished_at: now(), lease_until: null, heartbeat_at: now() }) },
    async markInterrupted(id, reason) { return this.finishRun(id, 'interrupted', { recovery: reason }) },
    async markStartFailed(id, message = 'worker_start_failed') { return this.finishRun(id, 'failed', { recovery: 'worker_start_failed', error_code: 'WORKER_START_FAILED', error_message: message }) },
    async recoverExpiredRuns() { return 0 },
    async createStepRun({ runId, stepKey, scriptSnapshot = {}, attempt = 1, status = 'running', inputHash = null } = {}) {
      const created = now()
      const result = await client.insert('collection_step_runs', { run_id: runId, step_key: stepKey, script_snapshot: scriptSnapshot, attempt, status, started_at: status === 'running' ? created : null, input_hash: inputHash, created_at: created, updated_at: created })
      return first(rows(result))
    },
    async finishStepRun(id, patch = {}) { const result = await client.patch('collection_step_runs', [{ column: 'id', operator: 'eq', value: id }], { ...patch, updated_at: now() }); return first(rows(result)) },
    async listStepRuns(runId) { return rows(await client.list('collection_step_runs', { filters: [{ column: 'run_id', operator: 'eq', value: runId }], order: [{ column: 'created_at', direction: 'asc' }] })) },
    async getStepRuns(runId, stepKey) { return rows(await client.list('collection_step_runs', { filters: [{ column: 'run_id', operator: 'eq', value: runId }, { column: 'step_key', operator: 'eq', value: stepKey }], order: [{ column: 'attempt', direction: 'asc' }] })) },
    async cancelRun(id) { return this.updateRun(id, { status: 'cancelled', finished_at: now(), lease_until: null }) }
  })
}
