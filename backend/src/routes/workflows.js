import express from "express";
import { listAllWorkflows, getWorkflowById } from "../clients/n8n.js";
import { runJobAndWait } from "../clients/jenkins.js";
import { config } from "../config.js";
import { pool, prodPool } from "../clients/db.js";

export const workflowsRouter = express.Router();

function extractCredentialIdsFromWorkflow(workflow) {
  const ids = new Set();
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];

  for (const node of nodes) {
    const credentials = node?.credentials;
    if (!credentials || typeof credentials !== "object") continue;

    for (const value of Object.values(credentials)) {
      if (value && typeof value === "object" && value.id) {
        ids.add(String(value.id));
      }
    }
  }

  return [...ids];
}

async function findMissingCredentialsByIds(credentialIds) {
  if (!credentialIds.length) return [];

  const { rows: devRows } = await pool.query(
    `
      SELECT id, name, type, "updatedAt"
      FROM public.credentials_metadata
      WHERE CAST(id AS TEXT) = ANY($1::text[])
      ORDER BY name ASC;
    `,
    [credentialIds]
  );

  if (!devRows.length) return [];

  const devIdSet = new Set(devRows.map((r) => String(r.id)));

  const { rows: prodRows } = await prodPool.query(
    `
      SELECT CAST(id AS TEXT) AS id
      FROM public.credentials_entity
      WHERE CAST(id AS TEXT) = ANY($1::text[]);
    `,
    [[...devIdSet]]
  );

  const prodIdSet = new Set(prodRows.map((r) => String(r.id)));

  return devRows
    .filter((r) => !prodIdSet.has(String(r.id)))
    .map((r) => ({
      id: String(r.id),
      name: r.name,
      type: r.type,
      updatedAt: r.updatedAt,
    }));
}

async function getWorkflowMissingCredentials(workflowId) {
  const workflow = await getWorkflowById(workflowId);
  const credentialIds = extractCredentialIdsFromWorkflow(workflow);
  const missingCredentials = await findMissingCredentialsByIds(credentialIds);

  return {
    workflowId,
    credentialIds,
    missingCredentials,
  };
}

async function runPromoteMissingCredentials(missingCredentials, steps) {
  if (missingCredentials.length === 0) return { state: "SUCCESS" };

  const missingIds = missingCredentials.map((c) => c.id);
  const promoteParams = { [config.jenkins.credIdsParam]: missingIds.join(",") };
  const promoteStep = await runJobAndWait(config.jenkins.jobPromoteCreds, promoteParams, {
    stopOnApproval: true,
  });
  steps.push({ ...promoteStep, label: "PROMOTE_CREDS", credentials: missingCredentials });

  if (promoteStep.state === "AWAITING_APPROVAL") return { state: "AWAITING_APPROVAL" };
  if (promoteStep.state !== "FINISHED" || promoteStep.result !== "SUCCESS") return { state: "FAILED" };

  return { state: "SUCCESS" };
}

workflowsRouter.get("/", async (req, res) => {
  try {
    const workflows = await listAllWorkflows();
    res.json({ data: workflows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

workflowsRouter.get("/:id/credentials-diff", async (req, res) => {
  try {
    const result = await getWorkflowMissingCredentials(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

workflowsRouter.post("/:id/push-git", async (req, res) => {
  const workflowId = req.params.id;
  const params = { [config.jenkins.workflowParam]: workflowId };

  try {
    const step = await runJobAndWait(config.jenkins.jobDevToGit, params);
    if (step.state !== "FINISHED" || step.result !== "SUCCESS") {
      return res.status(500).json({ error: "DEV_TO_GIT failed", steps: [step] });
    }
    res.json({ workflowId, state: "SUCCESS", steps: [step] });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

workflowsRouter.post("/:id/push", async (req, res) => {
  const workflowId = req.params.id;
  const params = { [config.jenkins.workflowParam]: workflowId };

  try {
    const { missingCredentials } = await getWorkflowMissingCredentials(workflowId);
    const steps = [];

    const promoteStatus = await runPromoteMissingCredentials(missingCredentials, steps);
    if (promoteStatus.state === "AWAITING_APPROVAL") {
      return res.json({ workflowId, state: "AWAITING_APPROVAL", missingCredentials, steps });
    }
    if (promoteStatus.state === "FAILED") {
      return res.status(500).json({ error: "PROMOTE_CREDS failed", missingCredentials, steps });
    }

    const step1 = await runJobAndWait(config.jenkins.jobDevToGit, params);
    steps.push({ ...step1, label: "DEV_TO_GIT" });
    if (step1.state !== "FINISHED" || step1.result !== "SUCCESS") {
      return res.status(500).json({ error: "DEV_TO_GIT failed", missingCredentials, steps });
    }

    const step2 = await runJobAndWait(config.jenkins.jobDeployFromGit, params, { stopOnApproval: true });
    steps.push({ ...step2, label: "DEPLOY_FROM_GIT" });

    if (step2.state === "AWAITING_APPROVAL") {
      return res.json({ workflowId, state: "AWAITING_APPROVAL", missingCredentials, steps });
    }

    if (step2.state !== "FINISHED" || step2.result !== "SUCCESS") {
      return res.status(500).json({ error: "DEPLOY_FROM_GIT failed", missingCredentials, steps });
    }

    res.json({ workflowId, state: "SUCCESS", missingCredentials, steps });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

workflowsRouter.post("/:id/pull-git", async (req, res) => {
  const workflowId = req.params.id;
  const params = { [config.jenkins.workflowParam]: workflowId };

  try {
    const { missingCredentials } = await getWorkflowMissingCredentials(workflowId);
    const steps = [];

    const promoteStatus = await runPromoteMissingCredentials(missingCredentials, steps);
    if (promoteStatus.state === "AWAITING_APPROVAL") {
      return res.json({ workflowId, state: "AWAITING_APPROVAL", missingCredentials, steps });
    }
    if (promoteStatus.state === "FAILED") {
      return res.status(500).json({ error: "PROMOTE_CREDS failed", missingCredentials, steps });
    }

    const deployStep = await runJobAndWait(config.jenkins.jobDeployFromGit, params, { stopOnApproval: true });
    steps.push({ ...deployStep, label: "DEPLOY_FROM_GIT" });

    if (deployStep.state === "AWAITING_APPROVAL") {
      return res.json({ workflowId, state: "AWAITING_APPROVAL", missingCredentials, steps });
    }

    if (deployStep.state !== "FINISHED" || deployStep.result !== "SUCCESS") {
      return res.status(500).json({ error: "DEPLOY_FROM_GIT failed", missingCredentials, steps });
    }

    res.json({ workflowId, state: "SUCCESS", missingCredentials, steps });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
