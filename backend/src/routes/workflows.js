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

workflowsRouter.post("/:id/push", async (req, res) => {
  const workflowId = req.params.id;

  const params = { [config.jenkins.workflowParam]: workflowId };

  try {
    // Step 1: DEV -> GIT
    const step1 = await runJobAndWait(config.jenkins.jobDevToGit, params);
    if (step1.result !== "SUCCESS") {
      return res.status(500).json({
        error: "DEV_TO_GIT failed",
        steps: [step1],
      });
    }

    // Step 2: GIT -> PROD
    const step2 = await runJobAndWait(config.jenkins.jobDeployFromGit, params);
    if (step2.result !== "SUCCESS") {
      return res.status(500).json({
        error: "DEPLOY_FROM_GIT failed",
        steps: [step1, step2],
      });
    }

    res.json({
      workflowId,
      steps: [step1, step2],
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});