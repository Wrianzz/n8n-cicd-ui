import axios from "axios";
import { config } from "../config.js";
import { sleep } from "../utils/sleep.js";

// "folder/sub/jobName" -> "job/folder/job/sub/job/jobName"
function toJobPath(jobNameOrPath) {
  const parts = jobNameOrPath.split("/").filter(Boolean);
  return parts.map((p) => `job/${encodeURIComponent(p)}`).join("/");
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
          url: first?.url || null, // kadang relative
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
    message: first?.message || null,
    proceedText: first?.proceedText || null,
    id: first?.id || first?.input?.id || null,
    url: first?.url || first?.proceedUrl || null,
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
  };
}

async function detectPendingApproval(buildUrl) {
  try {
    const pendingActions = await getJsonAbsolute(`${buildUrl}wfapi/pendingInputActions`);
    const pendingApproval = extractApprovalFromPendingActions(pendingActions);
    if (pendingApproval) return pendingApproval;
  } catch {
    // Endpoint wfapi bisa tidak tersedia.
  }

  try {
    const wfDescribe = await getJsonAbsolute(`${buildUrl}wfapi/describe`);
    const pendingApproval = extractApprovalFromPendingActions(wfDescribe?.pendingInputActions);
    if (pendingApproval) return pendingApproval;

    if (String(wfDescribe?.status || "").includes("PENDING_INPUT")) {
      return { message: wfDescribe?.message || "Awaiting approval", proceedText: null, id: null, url: null };
    }
  } catch {
    // Endpoint wfapi/describe bisa tidak tersedia.
  }

  try {
    const inputApi = await getJsonAbsolute(`${buildUrl}input/api/json`);
    const classicApproval = extractApprovalFromClassicInputApi(inputApi);
    if (classicApproval) return classicApproval;
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

  return { queueUrl: location.endsWith("/") ? location : `${location}/` };
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
        buildUrl: q.executable.url.endsWith("/") ? q.executable.url : `${q.executable.url}/`,
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
  // gunakan tree supaya payload kecil
  const url = `${buildUrl}api/json?tree=building,result,actions[_class,inputs[id,message,proceedText,url]]`;
  const b = await getJsonAbsolute(url);

  const approval = extractApprovalInfo(b);
  if (approval) {
    return { state: "AWAITING_APPROVAL", approval };
  }

  // Fallback lintas variasi Jenkins/Pipeline plugin ketika InputAction belum muncul di actions[].
  if (b.building) {
    const pendingApproval = await detectPendingApproval(buildUrl);
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
  
  // 1. Cek apakah stopOnApproval beneran true dari pemanggilnya
  console.log(`[DEBUG JENKINS] Mulai pantau: ${buildUrl} | stopOnApproval: ${stopOnApproval}`); 

  while (true) {
    if (Date.now() - startedAt > config.jenkins.jobTimeoutMs) {
      throw new Error(`Timeout waiting build state: ${buildUrl}`);
    }

    const state = await getBuildState(buildUrl);
    
    // 2. Cek state apa yang didapat dari Jenkins di tiap loop
    console.log(`[DEBUG JENKINS] State saat ini: ${state.state}`);

    if (state.state === "AWAITING_APPROVAL" && stopOnApproval) {
      console.log("[DEBUG JENKINS] Approval terdeteksi! Keluar dari loop.");
      return state;
    }
    
    if (state.state === "FINISHED") {
      console.log("[DEBUG JENKINS] Build selesai. Keluar dari loop.");
      return state;
    }

    await sleep(config.jenkins.pollIntervalMs);
  }
}

export async function runJobAndWait(jobNameOrPath, paramsObj, opts = {}) {
  const { stopOnApproval = true } = opts;

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
