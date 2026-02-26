import express from "express";
import { getBuildState } from "../clients/jenkins.js";
import { config } from "../config.js";

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

jenkinsRouter.get("/build-status", async (req, res) => {
  const buildUrl = String(req.query.buildUrl || "");
  if (!buildUrl) return res.status(400).json({ error: "buildUrl is required" });
  if (!isAllowedJenkinsUrl(buildUrl)) return res.status(400).json({ error: "buildUrl not allowed" });

  try {
    const state = await getBuildState(buildUrl.endsWith("/") ? buildUrl : `${buildUrl}/`);
    res.json(state);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
