import { backendPool } from "../clients/db.js";

let initialized = false;

async function ensureTable() {
  if (initialized) return;

  await backendPool.query(`
    CREATE TABLE IF NOT EXISTS public.deployment_history (
      id BIGSERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('WORKFLOW', 'CREDENTIAL')),
      entity_id TEXT,
      entity_name TEXT,
      action TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED', 'AWAITING_APPROVAL', 'RUNNING')),
      build_url TEXT,
      details TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await backendPool.query(`
    CREATE INDEX IF NOT EXISTS idx_deployment_history_created_at
      ON public.deployment_history (created_at DESC);
  `);

  await backendPool.query(`
    CREATE INDEX IF NOT EXISTS idx_deployment_history_status_created
      ON public.deployment_history (status, created_at DESC);
  `);

  initialized = true;
}

export async function recordHistory(entry) {
  await ensureTable();

  await backendPool.query(
    `
      INSERT INTO public.deployment_history
      (entity_type, entity_id, entity_name, action, status, build_url, details, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
    `,
    [
      entry.entityType,
      entry.entityId ? String(entry.entityId) : null,
      entry.entityName || null,
      entry.action,
      entry.status,
      entry.buildUrl || null,
      entry.details || null,
      JSON.stringify(entry.metadata || {}),
    ]
  );
}

export async function getHistorySummary({ days = 7, status }) {
  await ensureTable();

  const params = [days];
  let statusWhere = "";
  if (status && status !== "ALL") {
    params.push(status);
    statusWhere = ` WHERE status = $${params.length}`;
  }

  const { rows: healthRows } = await backendPool.query(
    `
      WITH latest AS (
        SELECT DISTINCT ON (entity_type, entity_id, action)
          entity_type,
          entity_id,
          action,
          status,
          created_at
        FROM public.deployment_history
        WHERE created_at >= NOW() - ($1::text || ' days')::interval
        ORDER BY entity_type, entity_id, action, created_at DESC, id DESC
      )
      SELECT status, COUNT(*)::int AS total
      FROM latest
      ${statusWhere}
      GROUP BY status
    `,
    params
  );

  const { rows: approvalRows } = await backendPool.query(
    `
      WITH latest AS (
        SELECT DISTINCT ON (entity_type, entity_id, action)
          id,
          entity_id,
          entity_name,
          action,
          status,
          build_url,
          details,
          created_at
        FROM public.deployment_history
        WHERE created_at >= NOW() - ($1::text || ' days')::interval
        ORDER BY entity_type, entity_id, action, created_at DESC, id DESC
      )
      SELECT id, entity_id, entity_name, action, status, build_url, details, created_at
      FROM latest
      WHERE status = 'AWAITING_APPROVAL'
      ORDER BY created_at DESC
      LIMIT 20
    `,
    [days]
  );

  const { rows: activityRows } = await backendPool.query(
    `
      WITH latest AS (
        SELECT DISTINCT ON (entity_type, entity_id, action)
          id,
          entity_type,
          entity_id,
          entity_name,
          action,
          status,
          build_url,
          details,
          created_at
        FROM public.deployment_history
        ORDER BY entity_type, entity_id, action, created_at DESC, id DESC
      )
      SELECT id, entity_type, entity_id, entity_name, action, status, build_url, details, created_at
      FROM latest
      ORDER BY created_at DESC
      LIMIT 20
    `
  );

  return {
    health: healthRows,
    approvals: approvalRows,
    activity: activityRows,
  };
}
