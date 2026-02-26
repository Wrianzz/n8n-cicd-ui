import express from "express";
import { listAllWorkflows } from "../clients/n8n.js";
import { pool, prodPool } from "../clients/db.js";
import { getHistorySummary } from "../utils/history.js";

export const dashboardRouter = express.Router();

dashboardRouter.get("/summary", async (req, res) => {
  const days = Number(req.query.days || 7);
  const healthStatus = String(req.query.healthStatus || "ALL").toUpperCase();

  try {
    const [workflows, credsResult, prodCredsResult, history] = await Promise.all([
      listAllWorkflows(),
      pool.query(`SELECT COUNT(*)::int AS total FROM public.credentials_metadata`),
      prodPool.query(`SELECT COUNT(*)::int AS total FROM public.credentials_entity`),
      getHistorySummary({ days: Number.isNaN(days) ? 7 : days, status: healthStatus }),
    ]);

    const totalWorkflows = workflows.length;
    const activeWorkflows = workflows.filter((w) => !!w.active).length;
    const totalCredentials = credsResult.rows[0]?.total || 0;
    const credsInProduction = Math.min(prodCredsResult.rows[0]?.total || 0, totalCredentials);
    const credsNotInProduction = Math.max(totalCredentials - credsInProduction, 0);

    const healthCounts = {
      SUCCESS: 0,
      FAILED: 0,
      AWAITING_APPROVAL: 0,
      RUNNING: 0,
    };

    for (const row of history.health) {
      healthCounts[row.status] = row.total;
    }

    const readinessPct = totalCredentials > 0 ? Math.round((credsInProduction / totalCredentials) * 100) : 0;

    res.json({
      kpi: {
        totalWorkflows,
        activeWorkflows,
        totalCredentials,
        credentialsInProduction: credsInProduction,
        credentialsNotInProduction: credsNotInProduction,
      },
      deploymentHealth: {
        days,
        filter: healthStatus,
        counts: healthCounts,
      },
      approvals: history.approvals,
      credentialReadiness: {
        percentage: readinessPct,
        inProduction: credsInProduction,
        total: totalCredentials,
      },
      recentActivity: history.activity,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
