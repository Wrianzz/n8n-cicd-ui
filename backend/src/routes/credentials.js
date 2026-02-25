import express from "express";
import { pool, prodPool } from "../clients/db.js";
import { runJobAndWait } from "../clients/jenkins.js";
import { config } from "../config.js";

export const credentialsRouter = express.Router();

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

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        inProduction: prodIdSet.has(String(r.id)),
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

    if (step.state === "AWAITING_APPROVAL") {
      return res.json({ state: "AWAITING_APPROVAL", steps: [step] });
    }

    if (step.state !== "FINISHED" || step.result !== "SUCCESS") {
      return res.status(500).json({ error: "PROMOTE_CREDS failed", steps: [step] });
    }

    res.json({ state: "SUCCESS", steps: [step] });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
