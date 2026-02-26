import axios from "axios";
import { config } from "../config.js";
import { sleep } from "../utils/sleep.js";

// "folder/sub/jobName" -> "job/folder/job/sub/job/jobName"
function toJobPath(jobNameOrPath) {
  const parts = jobNameOrPath.split("/").filter(Boolean);
  return parts.map((p) => `job/${encodeURIComponent(p)}`).join("/");
}

function withTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function toAbsoluteUrl(baseUrl, maybeRelativeUrl) {
  if (!maybeRelativeUrl) return null;
  try {
    return new URL(maybeRelativeUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

const jenkins = axios.create({
  baseURL: config.jenkins.baseUrl,
  timeout: 30000,
  auth: { username: config.jenkins.user, password: config.jenkins.token },
  maxRedirects: 0,
  validateStatus: (s) => s >= 200 && s < 400,
});

async function getCrumbIfNeeded() {
  // Dengan API token biasanya exempt, tapi ambil crumb tetap aman.
  try {
    const res = await jenkins.get("/crumbIssuer/api/json");
    const field = res.data?.crumbRequestField;
    const crumb = res.data?.crumb;
    if (field && crumb) return { field, crumb };
  } catch {}
  return null;
}

function extractApprovalInfo(buildJson) {
  const actions = Array.isArray(buildJson?.actions) ? buildJson.actions : [];
  for (const a of actions) {
    const cls = String(a?._class || "");
    // umum: org.jenkinsci.plugins.workflow.support.steps.input.InputAction
    if (cls.includes("InputAction")) {
      const inputs = Array.isArray(a?.inputs) ? a.inputs : [];
      if (inputs.length > 0) {
        const first = inputs[0];
        return {
          message: first?.message || null,
          proceedText: first?.proceedText || null,
          id: first?.id || null,
          url: first?.url || null,
          proceedUrl: first?.proceedUrl || null,
          abortUrl: first?.abortUrl || null,
        };
      }
    }
  }
  return null;
}

function extractApprovalFromPendingActions(pendingActions) {
  const actions = Array.isArray(pendingActions) ? pendingActions : [];
  if (actions.length === 0) return null;

  const first = actions[0];
  return {
    message: first?.message || first?.input?.message || null,
    proceedText: first?.proceedText || first?.input?.proceedText || null,
    id: first?.id || first?.input?.id || null,
    url: first?.url || null,
    proceedUrl: first?.proceedUrl || null,
    abortUrl: first?.abortUrl || null,
  };
}

function extractApprovalFromClassicInputApi(inputApiJson) {
  const inputs = Array.isArray(inputApiJson?.inputs) ? inputApiJson.inputs : [];
  if (inputs.length === 0) return null;

  const first = inputs[0];
  return {
    message: first?.message || first?.caption || null,
    proceedText: first?.ok || first?.proceedText || null,
    id: first?.id || null,
    url: first?.url || null,
    proceedUrl: first?.proceedUrl || null,
    abortUrl: first?.abortUrl || null,
  };
}

function normalizeApprovalUrls(approval, buildUrl) {
  if (!approval) return null;
  const normalizedBuildUrl = withTrailingSlash(buildUrl);
  return {
    ...approval,
    url: toAbsoluteUrl(normalizedBuildUrl, approval.url),
    proceedUrl: toAbsoluteUrl(config.jenkins.baseUrl, approval.proceedUrl),
    abortUrl: toAbsoluteUrl(config.jenkins.baseUrl, approval.abortUrl),
    inputPageUrl: toAbsoluteUrl(normalizedBuildUrl, "input/"),
  };
}

function mapWfapiFinalResult(status) {
  const s = String(status || "").toUpperCase();
  if (s === "SUCCESS") return "SUCCESS";
  if (s === "FAILED") return "FAILURE";
  if (s === "ABORTED") return "ABORTED";
  if (s === "UNSTABLE") return "UNSTABLE";
  if (s === "NOT_BUILT") return "NOT_BUILT";
  return null;
}

async function detectPendingApproval(buildUrl, wfDescribe = null) {
  const normalizedBuildUrl = withTrailingSlash(buildUrl);

  if (wfDescribe) {
    const fromDescribe = extractApprovalFromPendingActions(wfDescribe?.pendingInputActions);
    if (fromDescribe) return normalizeApprovalUrls(fromDescribe, normalizedBuildUrl);

    const pendingHref = wfDescribe?._links?.pendingInputActions?.href;
    const pendingUrl = toAbsoluteUrl(normalizedBuildUrl, pendingHref);
    if (pendingUrl) {
      try {
        const pendingActions = await getJsonAbsolute(pendingUrl);
        const fromPendingLink = extractApprovalFromPendingActions(pendingActions);
        if (fromPendingLink) return normalizeApprovalUrls(fromPendingLink, normalizedBuildUrl);
      } catch {
        // Endpoint pending input dari describe bisa unavailable pada variasi plugin tertentu.
      }
    }

    const stages = Array.isArray(wfDescribe?.stages) ? wfDescribe.stages : [];
    const pausedStage = stages.find((s) => String(s?.status || "").toUpperCase() === "PAUSED_PENDING_INPUT");
    const statusUpper = String(wfDescribe?.status || "").toUpperCase();
    const awaitingByStatus = statusUpper === "PAUSED_PENDING_INPUT";

    if (pausedStage || awaitingByStatus) {
      return normalizeApprovalUrls(
        {
          message: pausedStage?.name || wfDescribe?.message || "Awaiting approval",
          proceedText: null,
          id: null,
          url: null,
          proceedUrl: null,
          abortUrl: null,
        },
        normalizedBuildUrl,
      );
    }
  }

  try {
    const pendingActions = await getJsonAbsolute(`${normalizedBuildUrl}wfapi/pendingInputActions`);
    const pendingApproval = extractApprovalFromPendingActions(pendingActions);
    if (pendingApproval) return normalizeApprovalUrls(pendingApproval, normalizedBuildUrl);
  } catch {
    // Endpoint wfapi bisa tidak tersedia.
  }

  try {
    const inputApi = await getJsonAbsolute(`${normalizedBuildUrl}input/api/json`);
    const classicApproval = extractApprovalFromClassicInputApi(inputApi);
    if (classicApproval) return normalizeApprovalUrls(classicApproval, normalizedBuildUrl);
  } catch {
    // Endpoint input/api/json bisa 404 saat tidak ada pending input.
  }

  return null;
}

async function getJsonAbsolute(url) {
  const res = await axios.get(url, {
    auth: { username: config.jenkins.user, password: config.jenkins.token },
    timeout: 30000,
    headers: { accept: "application/json" },
  });
  return res.data;
}

export async function triggerJob(jobNameOrPath, paramsObj) {
  const jobPath = toJobPath(jobNameOrPath);
  const endpoint = `/${jobPath}/buildWithParameters`;

  const crumb = await getCrumbIfNeeded();

  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(paramsObj)) form.set(k, String(v));

  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (crumb) headers[crumb.field] = crumb.crumb;

  const res = await jenkins.post(endpoint, form.toString(), { headers });

  const location = res.headers?.location;
  if (!location) throw new Error(`No Location header from Jenkins: ${jobNameOrPath}`);

  return { queueUrl: withTrailingSlash(location) };
}

export async function waitForBuildFromQueue(queueUrl) {
  const startedAt = Date.now();

  while (true) {
    if (Date.now() - startedAt > config.jenkins.jobTimeoutMs) {
      throw new Error(`Timeout waiting executable from queue: ${queueUrl}`);
    }

    const q = await getJsonAbsolute(`${queueUrl}api/json`);

    if (q.cancelled) throw new Error(`Queue item cancelled: ${queueUrl}`);

    if (q.executable?.url && q.executable?.number != null) {
      return {
        buildUrl: withTrailingSlash(q.executable.url),
        buildNumber: q.executable.number,
      };
    }

    await sleep(config.jenkins.pollIntervalMs);
  }
}

/**
 * Ambil status build saat ini (tanpa menunggu).
 * return:
 *  - { state: "BUILDING" }
 *  - { state: "AWAITING_APPROVAL", approval: {...} }
 *  - { state: "FINISHED", result: "SUCCESS"|"FAILURE"|... }
 */
export async function getBuildState(buildUrl) {
  const normalizedBuildUrl = withTrailingSlash(buildUrl);

  // 1) Prefer wfapi karena lebih akurat untuk paused input (approval)
  try {
    const wfDescribe = await getJsonAbsolute(`${normalizedBuildUrl}wfapi/describe`);
    const pendingApproval = await detectPendingApproval(normalizedBuildUrl, wfDescribe);
    if (pendingApproval) {
      return { state: "AWAITING_APPROVAL", approval: pendingApproval };
    }

    const wfResult = mapWfapiFinalResult(wfDescribe?.status);
    if (wfResult) return { state: "FINISHED", result: wfResult };

    if (String(wfDescribe?.status || "").toUpperCase() === "QUEUED") {
      return { state: "BUILDING" };
    }
  } catch {
    // ignore -> fallback ke core API
  }

  // 2) Fallback core API
  // gunakan tree supaya payload kecil
  const url = `${normalizedBuildUrl}api/json?tree=building,result,actions[_class,inputs[id,message,proceedText,url,proceedUrl,abortUrl]]`;
  const b = await getJsonAbsolute(url);

  const approval = normalizeApprovalUrls(extractApprovalInfo(b), normalizedBuildUrl);
  if (approval) {
    return { state: "AWAITING_APPROVAL", approval };
  }

  // Fallback lintas variasi Jenkins/Pipeline plugin ketika InputAction belum muncul di actions[].
  if (b.building) {
    const pendingApproval = await detectPendingApproval(normalizedBuildUrl);
    if (pendingApproval) {
      return { state: "AWAITING_APPROVAL", approval: pendingApproval };
    }
  }

  if (b.building) return { state: "BUILDING" };

  return { state: "FINISHED", result: b.result || "UNKNOWN" };
}

/**
 * Tunggu sampai FINISHED atau (opsional) berhenti saat approval.
 */
export async function waitForBuildFinalOrApproval(buildUrl, { stopOnApproval } = { stopOnApproval: false }) {
  const startedAt = Date.now();

  while (true) {
    if (Date.now() - startedAt > config.jenkins.jobTimeoutMs) {
      throw new Error(`Timeout waiting build state: ${buildUrl}`);
    }

    const state = await getBuildState(buildUrl);

    if (state.state === "AWAITING_APPROVAL" && stopOnApproval) return state;
    if (state.state === "FINISHED") return state;

    await sleep(config.jenkins.pollIntervalMs);
  }
}

export async function runJobAndWait(jobNameOrPath, paramsObj, opts = {}) {
  const { stopOnApproval = false } = opts;

  const { queueUrl } = await triggerJob(jobNameOrPath, paramsObj);
  const { buildUrl, buildNumber } = await waitForBuildFromQueue(queueUrl);

  const finalState = await waitForBuildFinalOrApproval(buildUrl, { stopOnApproval });

  return {
    job: jobNameOrPath,
    queueUrl,
    buildUrl,
    buildNumber,
    ...finalState, // state/result/approval
  };
}
