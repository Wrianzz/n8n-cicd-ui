import express from "express";
import { getBuildState } from "../clients/jenkins.js";
import { config } from "../config.js";
import { recordHistory } from "../utils/history.js";

export const jenkinsRouter = express.Router();

function isAllowedJenkinsUrl(raw) {
  try {
    const u = new URL(raw);
    const allowed = new URL(config.jenkins.baseUrl);
    // allow if same host:port (hindari SSRF)
    return u.host === allowed.host;
  } catch {
    return false;
  }
}

function normalizeHistoryStatus(buildState) {
  if (buildState?.state === "AWAITING_APPROVAL") return "AWAITING_APPROVAL";
  if (buildState?.state === "FINISHED") return buildState?.result === "SUCCESS" ? "SUCCESS" : "FAILED";
  return "RUNNING";
}

async function maybeSyncHistory(req, buildState, buildUrl) {
  const entityTypeRaw = String(req.query.entityType || "").trim().toUpperCase();
  const entityType = entityTypeRaw === "WORKFLOW" || entityTypeRaw === "CREDENTIAL" ? entityTypeRaw : null;
  const entityId = String(req.query.entityId || "").trim();
  const action = String(req.query.action || "").trim();
  const entityName = String(req.query.entityName || "").trim();
  const ids = String(req.query.ids || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  if (!entityType || !entityId || !action) return;

  // sinkronisasi hanya diperlukan saat build sudah selesai;
  // status awaiting/running sudah dicatat saat trigger job.
  if (buildState?.state !== "FINISHED") return;

  const status = normalizeHistoryStatus(buildState);
  const details = status === "SUCCESS"
    ? `${action} success`
    : `${action} failed${buildState?.result ? `: ${buildState.result}` : ""}`;

  await recordHistory({
    entityType,
    entityId,
    entityName: entityName || null,
    action,
    status,
    buildUrl,
    details,
    metadata: {
      source: "build-status-poller",
      buildState,
      ...(entityType === "CREDENTIAL" ? { ids: ids.length > 0 ? ids : [entityId] } : {}),
    },
  });
}

jenkinsRouter.get("/build-status", async (req, res) => {
  const buildUrl = String(req.query.buildUrl || "");
  if (!buildUrl) return res.status(400).json({ error: "buildUrl is required" });
  if (!isAllowedJenkinsUrl(buildUrl)) return res.status(400).json({ error: "buildUrl not allowed" });

  try {
    const normalizedBuildUrl = buildUrl.endsWith("/") ? buildUrl : `${buildUrl}/`;
    const state = await getBuildState(normalizedBuildUrl);
    await maybeSyncHistory(req, state, normalizedBuildUrl);
    res.json(state);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
