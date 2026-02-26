import express from "express";
import { listAllWorkflows, getWorkflowById } from "../clients/n8n.js";
import { runJobAndWait } from "../clients/jenkins.js";
import { config } from "../config.js";
import { pool, prodPool, backendPool } from "../clients/db.js";
import { recordHistory } from "../utils/history.js";

export const workflowsRouter = express.Router();



function workflowHistoryLabel(row) {
  if (!row) return "";
  if (row.details) return row.details;

  const action = row.action;
  const status = row.status;

  if (action === "PUSH_TO_GIT") {
    if (status === "SUCCESS") return "Pushed to Git";
    if (status === "AWAITING_APPROVAL") return "Push to Git awaiting approval";
    if (status === "FAILED") return "Push to Git failed";
    return "Pushing to Git...";
  }

  if (action === "PULL_FROM_GIT") {
    if (status === "SUCCESS") return "Pulled from Git";
    if (status === "AWAITING_APPROVAL") return "Pull awaiting approval";
    if (status === "FAILED") return "Pull from Git failed";
    return "Pulling from Git...";
  }

  if (action === "PUSH_TO_PROD") {
    if (status === "SUCCESS") return "Deployed to prod";
    if (status === "AWAITING_APPROVAL") return "Deploy awaiting approval";
    if (status === "FAILED") return "Push to prod failed";
    return "Promoting to prod...";
  }

  return status;
}

async function getLatestWorkflowHistory(workflowIds) {
  if (!Array.isArray(workflowIds) || workflowIds.length === 0) return new Map();

  const ids = workflowIds.map(String);
  const { rows } = await backendPool.query(
    `
      SELECT DISTINCT ON (entity_id)
        entity_id,
        action,
        status,
        details,
        build_url,
        metadata,
        created_at
      FROM public.deployment_history
      WHERE entity_type = 'WORKFLOW'
        AND entity_id = ANY($1::text[])
      ORDER BY entity_id, created_at DESC
    `,
    [ids]
  );

  const mapped = new Map();
  for (const row of rows) {
    const persistedSteps = Array.isArray(row?.metadata?.steps) ? row.metadata.steps : [];
    const steps = persistedSteps.length > 0 ? persistedSteps : row?.build_url ? [{ label: "Jenkins build", buildUrl: row.build_url }] : [];
    mapped.set(String(row.entity_id), {
      state: row.status,
      label: workflowHistoryLabel(row),
      steps,
      updatedAt: row.created_at,
    });
  }

  return mapped;
}


function normalizeStepState(step) {
  if (step?.state === "AWAITING_APPROVAL") return "AWAITING_APPROVAL";
  if (step?.state === "FINISHED" && step?.result === "SUCCESS") return "SUCCESS";
  if (step?.state === "FINISHED") return "FAILED";
  return "RUNNING";
}

async function logWorkflowEvent({ workflowId, workflowName, action, state, steps = [], details }) {
  const mainStep = Array.isArray(steps) ? steps[steps.length - 1] || steps[0] : null;
  await recordHistory({
    entityType: "WORKFLOW",
    entityId: workflowId,
    entityName: workflowName,
    action,
    status: state,
    buildUrl: mainStep?.buildUrl,
    details,
    metadata: { steps },
  });
}

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

workflowsRouter.get("/", async (req, res) => {
  try {
    const workflows = await listAllWorkflows();
    const historyByWorkflow = await getLatestWorkflowHistory(workflows.map((w) => w.id));

    const data = workflows.map((workflow) => ({
      ...workflow,
      lastState: historyByWorkflow.get(String(workflow.id)) || null,
    }));

    res.json({ data });
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
    const workflow = await getWorkflowById(workflowId);

    await logWorkflowEvent({
      workflowId,
      workflowName: workflow?.name,
      action: "PUSH_TO_GIT",
      state: "RUNNING",
      steps: [],
      details: "Pushing to Git...",
    });

    const step = await runJobAndWait(config.jenkins.jobDevToGit, params);
    const stepState = normalizeStepState(step);

    if (stepState !== "SUCCESS") {
      await logWorkflowEvent({ workflowId, workflowName: workflow?.name, action: "PUSH_TO_GIT", state: stepState, steps: [step], details: "DEV_TO_GIT failed" });
      return res.status(500).json({ error: "DEV_TO_GIT failed", steps: [step] });
    }

    await logWorkflowEvent({ workflowId, workflowName: workflow?.name, action: "PUSH_TO_GIT", state: "SUCCESS", steps: [step], details: "Workflow pushed to Git" });
    res.json({ workflowId, state: "SUCCESS", steps: [step] });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});


workflowsRouter.post("/:id/pull-git", async (req, res) => {
  const workflowId = req.params.id;
  const params = { [config.jenkins.workflowParam]: workflowId };

  try {
    const workflow = await getWorkflowById(workflowId);
    const { missingCredentials } = await getWorkflowMissingCredentials(workflowId);
    const steps = [];

    if (missingCredentials.length > 0) {
      const missingIds = missingCredentials.map((c) => c.id);
      const promoteParams = { [config.jenkins.credIdsParam]: missingIds.join(",") };
      const promoteStep = await runJobAndWait(config.jenkins.jobPromoteCreds, promoteParams, {
        stopOnApproval: true,
      });
      steps.push({ ...promoteStep, label: "PROMOTE_CREDS", credentials: missingCredentials });

      if (promoteStep.state === "AWAITING_APPROVAL") {
        await logWorkflowEvent({ workflowId, workflowName: workflow?.name, action: "PULL_FROM_GIT", state: "AWAITING_APPROVAL", steps, details: "Credential promotion awaiting approval" });
        return res.json({ workflowId, state: "AWAITING_APPROVAL", missingCredentials, steps });
      }

      if (promoteStep.state !== "FINISHED" || promoteStep.result !== "SUCCESS") {
        await logWorkflowEvent({ workflowId, workflowName: workflow?.name, action: "PULL_FROM_GIT", state: "FAILED", steps, details: "PROMOTE_CREDS failed" });
        return res.status(500).json({ error: "PROMOTE_CREDS failed", missingCredentials, steps });
      }
    }

    const step = await runJobAndWait(config.jenkins.jobDeployFromGit, params, { stopOnApproval: true });
    steps.push({ ...step, label: "DEPLOY_FROM_GIT" });

    if (step.state === "AWAITING_APPROVAL") {
      await logWorkflowEvent({ workflowId, workflowName: workflow?.name, action: "PULL_FROM_GIT", state: "AWAITING_APPROVAL", steps, details: "Deploy awaiting approval" });
      return res.json({ workflowId, state: "AWAITING_APPROVAL", missingCredentials, steps });
    }

    if (step.state !== "FINISHED" || step.result !== "SUCCESS") {
      await logWorkflowEvent({ workflowId, workflowName: workflow?.name, action: "PULL_FROM_GIT", state: "FAILED", steps, details: "DEPLOY_FROM_GIT failed" });
      return res.status(500).json({ error: "DEPLOY_FROM_GIT failed", missingCredentials, steps });
    }

    await logWorkflowEvent({ workflowId, workflowName: workflow?.name, action: "PULL_FROM_GIT", state: "SUCCESS", steps, details: "Workflow deployed from Git" });
    res.json({ workflowId, state: "SUCCESS", missingCredentials, steps });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

workflowsRouter.post("/:id/push", async (req, res) => {
  const workflowId = req.params.id;
  const params = { [config.jenkins.workflowParam]: workflowId };

  try {
    const workflow = await getWorkflowById(workflowId);
    const { missingCredentials } = await getWorkflowMissingCredentials(workflowId);
    const steps = [];

    if (missingCredentials.length > 0) {
      const missingIds = missingCredentials.map((c) => c.id);
      const promoteParams = { [config.jenkins.credIdsParam]: missingIds.join(",") };
      const promoteStep = await runJobAndWait(config.jenkins.jobPromoteCreds, promoteParams, {
        stopOnApproval: true,
      });
      steps.push({ ...promoteStep, label: "PROMOTE_CREDS", credentials: missingCredentials });

      if (promoteStep.state === "AWAITING_APPROVAL") {
        await logWorkflowEvent({ workflowId, workflowName: workflow?.name, action: "PUSH_TO_PROD", state: "AWAITING_APPROVAL", steps, details: "Credential promotion awaiting approval" });
        return res.json({ workflowId, state: "AWAITING_APPROVAL", missingCredentials, steps });
      }

      if (promoteStep.state !== "FINISHED" || promoteStep.result !== "SUCCESS") {
        await logWorkflowEvent({ workflowId, workflowName: workflow?.name, action: "PUSH_TO_PROD", state: "FAILED", steps, details: "PROMOTE_CREDS failed" });
        return res.status(500).json({ error: "PROMOTE_CREDS failed", missingCredentials, steps });
      }
    }

    const step1 = await runJobAndWait(config.jenkins.jobDevToGit, params);
    steps.push({ ...step1, label: "DEV_TO_GIT" });
    if (step1.state !== "FINISHED" || step1.result !== "SUCCESS") {
      await logWorkflowEvent({ workflowId, workflowName: workflow?.name, action: "PUSH_TO_PROD", state: "FAILED", steps, details: "DEV_TO_GIT failed" });
      return res.status(500).json({ error: "DEV_TO_GIT failed", missingCredentials, steps });
    }

    const step2 = await runJobAndWait(config.jenkins.jobDeployFromGit, params, { stopOnApproval: true });
    steps.push({ ...step2, label: "DEPLOY_FROM_GIT" });

    if (step2.state === "AWAITING_APPROVAL") {
      await logWorkflowEvent({ workflowId, workflowName: workflow?.name, action: "PUSH_TO_PROD", state: "AWAITING_APPROVAL", steps, details: "Deploy awaiting approval" });
      return res.json({ workflowId, state: "AWAITING_APPROVAL", missingCredentials, steps });
    }

    if (step2.state !== "FINISHED" || step2.result !== "SUCCESS") {
      await logWorkflowEvent({ workflowId, workflowName: workflow?.name, action: "PUSH_TO_PROD", state: "FAILED", steps, details: "DEPLOY_FROM_GIT failed" });
      return res.status(500).json({ error: "DEPLOY_FROM_GIT failed", missingCredentials, steps });
    }

    await logWorkflowEvent({ workflowId, workflowName: workflow?.name, action: "PUSH_TO_PROD", state: "SUCCESS", steps, details: "Workflow promoted to production" });
    res.json({ workflowId, state: "SUCCESS", missingCredentials, steps });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
