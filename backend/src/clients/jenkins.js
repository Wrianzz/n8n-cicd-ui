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

// Fallback: beberapa Jenkins lebih gampang dibaca dari endpoint input/api/json
async function fetchApprovalFromInputApi(buildUrl) {
  try {
    const data = await getJsonAbsolute(
      `${buildUrl}input/api/json?tree=inputs[id,message,proceedText,ok,cancel,url]`
    );

    const inputs = Array.isArray(data?.inputs) ? data.inputs : [];
    if (!inputs.length) return null;

    const first = inputs[0];
    return {
      message: first?.message || null,
      proceedText: first?.proceedText || first?.ok || null,
      id: first?.id || null,
      url: first?.url || (first?.id ? `input/${encodeURIComponent(first.id)}/` : "input/"),
      cancelText: first?.cancel || null,
    };
  } catch {
    return null;
  }
}

function extractApprovalInfo(buildJson) {
  const actions = Array.isArray(buildJson?.actions) ? buildJson.actions : [];

  for (const a of actions) {
    const cls = String(a?._class || "");
    if (!cls.includes("InputAction")) continue;

    // (A) Bentuk lama/varian: actions[].inputs[]
    const inputs = Array.isArray(a?.inputs) ? a.inputs : [];
    if (inputs.length > 0) {
      const first = inputs[0];
      return {
        message: first?.message || null,
        proceedText: first?.proceedText || first?.ok || null,
        id: first?.id || null,
        url: first?.url || (first?.id ? `input/${encodeURIComponent(first.id)}/` : "input/"),
        cancelText: first?.cancel || null,
      };
    }

    // (B) Bentuk umum plugin pipeline-input-step: actions[].executions[].input
    const executions = Array.isArray(a?.executions) ? a.executions : [];
    if (executions.length > 0) {
      // Input approval hanya valid kalau masih pending (belum settled).
      // Saat reject/abort, Jenkins sering masih mengirim executions tapi settled=true.
      const exec = executions.find((e) => e?.settled !== true);
      if (!exec) continue;

      const inp = exec?.input || {};
      const id = exec?.id || inp?.id || null;

      return {
        message: inp?.message || exec?.message || null,
        // di InputStep: caption tombol OK adalah "ok" (bukan proceedText)
        proceedText: inp?.ok || inp?.proceedText || null,
        id,
        url: exec?.url || (id ? `input/${encodeURIComponent(id)}/` : "input/"),
        cancelText: inp?.cancel || null,
      };
    }

    // (C) Kalau InputAction ada tapi detailnya tidak ikut ke JSON,
    // tandai awaiting hanya selama build masih berjalan.
    // (detail bisa dicoba via input/api/json di getBuildState)
    if (buildJson?.building) {
      return { message: null, proceedText: null, id: null, url: "input/", cancelText: null };
    }
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
  // NOTE:
  // InputAction biasanya expose "executions" -> InputStepExecution -> "input" (message/ok/cancel)
  // jadi kita include itu di tree agar approval kebaca.
  const url =
    `${buildUrl}api/json?tree=` +
    [
      "building",
      "result",
      "actions[_class,inputs[id,message,proceedText,ok,cancel,url],executions[id,settled,input[id,message,ok,cancel]]]",
    ].join(",");

  const b = await getJsonAbsolute(url);

  let approval = extractApprovalInfo(b);

  // Kalau ada InputAction tapi detailnya kosong, coba endpoint input/api/json
  if (approval && approval.message == null && approval.id == null) {
    const fromInputApi = await fetchApprovalFromInputApi(buildUrl);
    if (fromInputApi) approval = fromInputApi;
  } else if (!approval) {
    // juga coba input/api/json kalau parsing actions gagal (varian Jenkins tertentu)
    const fromInputApi = await fetchApprovalFromInputApi(buildUrl);
    if (fromInputApi) approval = fromInputApi;
  }

  if (approval) {
    return { state: "AWAITING_APPROVAL", approval };
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
