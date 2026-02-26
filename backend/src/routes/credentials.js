import express from "express";
import { pool, prodPool, backendPool } from "../clients/db.js";
import { runJobAndWait } from "../clients/jenkins.js";
import { config } from "../config.js";
import { recordHistory } from "../utils/history.js";

export const credentialsRouter = express.Router();



function credentialHistoryLabel(row) {
  if (!row) return "";
  if (row.details) return row.details;
  if (row.status === "SUCCESS") return "Promoted to prod";
  if (row.status === "AWAITING_APPROVAL") return "Awaiting approval";
  if (row.status === "FAILED") return "Promote failed";
  return "Promoting...";
}

async function getLatestCredentialHistory(credentialIds) {
  if (!Array.isArray(credentialIds) || credentialIds.length === 0) return new Map();

  const ids = credentialIds.map(String);
  const { rows } = await backendPool.query(
    `
      WITH expanded AS (
        SELECT
          h.id,
          h.action,
          h.status,
          h.details,
          h.build_url,
          h.metadata,
          h.created_at,
          jsonb_array_elements_text(COALESCE(h.metadata->'ids', '[]'::jsonb)) AS cred_id
        FROM public.deployment_history h
        WHERE h.entity_type = 'CREDENTIAL'
      )
      SELECT DISTINCT ON (cred_id)
        cred_id,
        action,
        status,
        details,
        build_url,
        metadata,
        created_at
      FROM expanded
      WHERE cred_id = ANY($1::text[])
      ORDER BY cred_id, created_at DESC
    `,
    [ids]
  );

  const mapped = new Map();
  for (const row of rows) {
    const persistedSteps = Array.isArray(row?.metadata?.steps) ? row.metadata.steps : [];
    const steps = persistedSteps.length > 0 ? persistedSteps : row?.build_url ? [{ label: "Promote build", buildUrl: row.build_url }] : [];
    mapped.set(String(row.cred_id), {
      state: row.status,
      label: credentialHistoryLabel(row),
      steps,
      updatedAt: row.created_at,
    });
  }

  return mapped;
}

// List credential metadata (no secrets)
credentialsRouter.get("/", async (req, res) => {
  const q = String(req.query.q || "").trim();

  try {
    const sql = q
      ? `
        SELECT id, name, type, "createdAt", "updatedAt"
        FROM public.credentials_metadata
        WHERE name ILIKE $1 OR type ILIKE $1 OR CAST(id AS TEXT) ILIKE $1
        ORDER BY "updatedAt" DESC
        LIMIT 200;
      `
      : `
        SELECT id, name, type, "createdAt", "updatedAt"
        FROM public.credentials_metadata
        ORDER BY "updatedAt" DESC
        LIMIT 200;
      `;

    const params = q ? [`%${q}%`] : [];
    const { rows } = await pool.query(sql, params);

    const ids = rows.map((r) => String(r.id));
    const { rows: prodRows } = ids.length
      ? await prodPool.query(
          `
            SELECT CAST(id AS TEXT) AS id
            FROM public.credentials_entity
            WHERE CAST(id AS TEXT) = ANY($1::text[]);
          `,
          [ids]
        )
      : { rows: [] };
    const prodIdSet = new Set(prodRows.map((r) => String(r.id)));

    const historyByCredential = await getLatestCredentialHistory(ids);

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        inProduction: prodIdSet.has(String(r.id)),
        lastState: historyByCredential.get(String(r.id)) || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Promote credentials by IDs via Jenkins (CRED_IDS=id1,id2,...)
credentialsRouter.post("/promote", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map(String).filter(Boolean)
      : String(req.body?.ids || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

    if (ids.length === 0) return res.status(400).json({ error: "ids is required" });

    const params = { [config.jenkins.credIdsParam]: ids.join(",") };

    const step = await runJobAndWait(config.jenkins.jobPromoteCreds, params, { stopOnApproval: true });

    const detail = `Promote credentials (${ids.join(",")})`;

    if (step.state === "AWAITING_APPROVAL") {
      await recordHistory({
        entityType: "CREDENTIAL",
        entityId: ids.join(","),
        action: "PROMOTE_CREDENTIAL",
        status: "AWAITING_APPROVAL",
        buildUrl: step?.buildUrl,
        details: `${detail} awaiting approval`,
        metadata: { ids, steps: [step] },
      });
      return res.json({ state: "AWAITING_APPROVAL", steps: [step] });
    }

    if (step.state !== "FINISHED" || step.result !== "SUCCESS") {
      await recordHistory({
        entityType: "CREDENTIAL",
        entityId: ids.join(","),
        action: "PROMOTE_CREDENTIAL",
        status: "FAILED",
        buildUrl: step?.buildUrl,
        details: `${detail} failed`,
        metadata: { ids, steps: [step] },
      });
      return res.status(500).json({ error: "PROMOTE_CREDS failed", steps: [step] });
    }

    await recordHistory({
      entityType: "CREDENTIAL",
      entityId: ids.join(","),
      action: "PROMOTE_CREDENTIAL",
      status: "SUCCESS",
      buildUrl: step?.buildUrl,
      details: `${detail} success`,
      metadata: { ids, steps: [step] },
    });

    res.json({ state: "SUCCESS", steps: [step] });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
