import express from "express";
import { listAllWorkflows } from "../clients/n8n.js";
import { runJobAndWait } from "../clients/jenkins.js";
import { config } from "../config.js";

export const workflowsRouter = express.Router();

workflowsRouter.get("/", async (req, res) => {
  try {
    const workflows = await listAllWorkflows();
    res.json({ data: workflows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ✅ Push to Git: hanya panggil n8n-dev-to-git
workflowsRouter.post("/:id/push-git", async (req, res) => {
  const workflowId = req.params.id;
  const params = { [config.jenkins.workflowParam]: workflowId };

  try {
    const step = await runJobAndWait(config.jenkins.jobDevToGit, params);
    // harus selesai & sukses
    if (step.state !== "FINISHED" || step.result !== "SUCCESS") {
      return res.status(500).json({ error: "DEV_TO_GIT failed", steps: [step] });
    }
    res.json({ workflowId, state: "SUCCESS", steps: [step] });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ✅ Push to Prod: dev->git lalu deploy-from-git (stop kalau approval)
workflowsRouter.post("/:id/push", async (req, res) => {
  const workflowId = req.params.id;
  const params = { [config.jenkins.workflowParam]: workflowId };

  try {
    const step1 = await runJobAndWait(config.jenkins.jobDevToGit, params);
    if (step1.state !== "FINISHED" || step1.result !== "SUCCESS") {
      return res.status(500).json({ error: "DEV_TO_GIT failed", steps: [step1] });
    }

    const step2 = await runJobAndWait(config.jenkins.jobDeployFromGit, params, { stopOnApproval: true });

    if (step2.state === "AWAITING_APPROVAL") {
      return res.json({ workflowId, state: "AWAITING_APPROVAL", steps: [step1, step2] });
    }

    if (step2.state !== "FINISHED" || step2.result !== "SUCCESS") {
      return res.status(500).json({ error: "DEPLOY_FROM_GIT failed", steps: [step1, step2] });
    }

    res.json({ workflowId, state: "SUCCESS", steps: [step1, step2] });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});