import axios from "axios";
import { config } from "../config.js";
import { sleep } from "../utils/sleep.js";

// Ubah "folder/sub/jobName" -> "job/folder/job/sub/job/jobName"
function toJobPath(jobNameOrPath) {
  const parts = jobNameOrPath.split("/").filter(Boolean);
  return parts.map((p) => `job/${encodeURIComponent(p)}`).join("/");
}

const jenkins = axios.create({
  baseURL: config.jenkins.baseUrl,
  timeout: 30000,
  auth: {
    username: config.jenkins.user,
    password: config.jenkins.token,
  },
  // axios akan follow redirect by default untuk GET; untuk POST kita biarkan.
  maxRedirects: 0,
  validateStatus: (s) => s >= 200 && s < 400,
});

async function getCrumbIfNeeded() {
  // Dengan API token, request POST umumnya exempt dari CSRF crumb :contentReference[oaicite:12]{index=12}
  // Tapi ambil crumb tetap aman; kalau instance kamu butuh, ini menyelamatkan.
  try {
    const res = await jenkins.get("/crumbIssuer/api/json");
    const field = res.data?.crumbRequestField;
    const crumb = res.data?.crumb;
    if (field && crumb) return { field, crumb };
  } catch {
    // ignore: banyak instance tidak expose crumbIssuer atau tidak butuh
  }
  return null;
}

export async function triggerJob(jobNameOrPath, paramsObj) {
  const jobPath = toJobPath(jobNameOrPath);
  const endpoint = `/${jobPath}/buildWithParameters`;

  const crumb = await getCrumbIfNeeded();

  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(paramsObj)) form.set(k, String(v));

  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (crumb) headers[crumb.field] = crumb.crumb;

  const res = await jenkins.post(endpoint, form.toString(), { headers });

  // Jenkins biasanya mengembalikan Location header ke queue item untuk dipoll :contentReference[oaicite:13]{index=13}
  const location = res.headers?.location;
  if (!location) {
    throw new Error(`No Location header from Jenkins when triggering job: ${jobNameOrPath}`);
  }

  return { queueUrl: location.endsWith("/") ? location : `${location}/` };
}

async function getJsonAbsolute(url) {
  // queueUrl dari Location biasanya absolute; pakai axios langsung
  const res = await axios.get(url, {
    auth: { username: config.jenkins.user, password: config.jenkins.token },
    timeout: 30000,
    headers: { accept: "application/json" },
  });
  return res.data;
}

export async function waitForBuildFromQueue(queueUrl) {
  const startedAt = Date.now();

  while (true) {
    if (Date.now() - startedAt > config.jenkins.jobTimeoutMs) {
      throw new Error(`Timeout waiting executable from queue: ${queueUrl}`);
    }

    const q = await getJsonAbsolute(`${queueUrl}api/json`);

    if (q.cancelled) {
      throw new Error(`Queue item cancelled: ${queueUrl}`);
    }

    if (q.executable?.url && q.executable?.number != null) {
      return {
        buildUrl: q.executable.url.endsWith("/") ? q.executable.url : `${q.executable.url}/`,
        buildNumber: q.executable.number,
      };
    }

    await sleep(config.jenkins.pollIntervalMs);
  }
}

export async function waitForBuildResult(buildUrl) {
  const startedAt = Date.now();

  while (true) {
    if (Date.now() - startedAt > config.jenkins.jobTimeoutMs) {
      throw new Error(`Timeout waiting build result: ${buildUrl}`);
    }

    const b = await getJsonAbsolute(`${buildUrl}api/json`);
    if (b.building === false) {
      return {
        result: b.result, // SUCCESS / FAILURE / ABORTED
        duration: b.duration,
        timestamp: b.timestamp,
      };
    }

    await sleep(config.jenkins.pollIntervalMs);
  }
}

export async function runJobAndWait(jobNameOrPath, paramsObj) {
  const { queueUrl } = await triggerJob(jobNameOrPath, paramsObj);
  const { buildUrl, buildNumber } = await waitForBuildFromQueue(queueUrl);
  const final = await waitForBuildResult(buildUrl);

  return {
    job: jobNameOrPath,
    queueUrl,
    buildUrl,
    buildNumber,
    ...final,
  };
}