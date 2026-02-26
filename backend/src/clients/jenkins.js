// backend/src/clients/jenkins.ts
import axios from "axios";
import { config } from "../config.js";

export type UiBuildPhase =
  | "QUEUED"
  | "IN_PROGRESS"
  | "AWAITING_APPROVAL"
  | "SUCCESS"
  | "FAILED"
  | "ABORTED"
  | "UNSTABLE"
  | "NOT_BUILT"
  | "UNKNOWN";

export type BuildState = {
  phase: UiBuildPhase;
  rawStatus?: string;
  stage?: string;

  // khusus approval (optional)
  message?: string;
  inputPageUrl?: string; // halaman UI Jenkins untuk approve
  proceedUrl?: string;   // endpoint proceed (biasanya butuh POST)
  abortUrl?: string;     // endpoint abort (biasanya butuh POST)
};

const http = axios.create({
  // kalau kamu sudah pakai auth di tempat lain, sesuaikan
  auth: config.jenkins.user && config.jenkins.apiToken
    ? { username: config.jenkins.user, password: config.jenkins.apiToken }
    : undefined,
  headers: { Accept: "application/json" },
  timeout: 10_000,
});

export async function getBuildState(buildUrl: string): Promise<BuildState> {
  const normalized = buildUrl.endsWith("/") ? buildUrl : `${buildUrl}/`;

  // 1) Prefer: wfapi (Pipeline: REST API plugin)
  try {
    const describeUrl = new URL("wfapi/describe", normalized).toString();
    const { data } = await http.get(describeUrl);

    const raw = String(data?.status ?? "UNKNOWN");

    const stages = Array.isArray(data?.stages) ? data.stages : [];
    const pausedStage = stages.find((s: any) => s?.status === "PAUSED_PENDING_INPUT");
    const hasPendingLink = Boolean(data?._links?.pendingInputActions?.href);

    const isAwaiting =
      raw === "PAUSED_PENDING_INPUT" || hasPendingLink || Boolean(pausedStage);

    if (isAwaiting) {
      // Optional: ambil message + proceed/abort dari pendingInputActions
      let pending: any[] | undefined;
      try {
        const pendingUrl = new URL("wfapi/pendingInputActions", normalized).toString();
        const r = await http.get(pendingUrl);
        pending = Array.isArray(r.data) ? r.data : undefined;
      } catch {
        // tetap return awaiting approval walau pending actions gagal di-fetch
      }

      const first = pending?.[0];

      return {
        phase: "AWAITING_APPROVAL",
        rawStatus: raw,
        stage: pausedStage?.name ?? "Approval",
        message: first?.message,
        // halaman approve UI Jenkins umumnya ada di /<build>/input/
        inputPageUrl: new URL("input/", normalized).toString(),
        // proceedUrl/abortUrl dari wfapi biasanya relative -> jadikan absolute
        proceedUrl: first?.proceedUrl
          ? new URL(first.proceedUrl, config.jenkins.baseUrl).toString()
          : undefined,
        abortUrl: first?.abortUrl
          ? new URL(first.abortUrl, config.jenkins.baseUrl).toString()
          : undefined,
      };
    }

    // Not awaiting approval → map status normal
    return {
      phase: mapWfapiStatus(raw),
      rawStatus: raw,
      stage: currentStageName(stages),
    };
  } catch {
    // ignore → fallback
  }

  // 2) Fallback: core API (tidak bisa bedain paused input vs running)
  const apiUrl = new URL("api/json?tree=building,result", normalized).toString();
  const { data } = await http.get(apiUrl);

  const building = Boolean(data?.building);
  const result = data?.result ? String(data.result) : null;

  if (building) return { phase: "IN_PROGRESS", rawStatus: "IN_PROGRESS" };
  if (result) return { phase: mapCoreResult(result), rawStatus: result };

  return { phase: "UNKNOWN" };
}

function mapWfapiStatus(s: string): UiBuildPhase {
  switch (s) {
    case "SUCCESS": return "SUCCESS";
    case "FAILED": return "FAILED";
    case "ABORTED": return "ABORTED";
    case "UNSTABLE": return "UNSTABLE";
    case "NOT_BUILT": return "NOT_BUILT";
    case "IN_PROGRESS": return "IN_PROGRESS";
    case "QUEUED": return "QUEUED";
    default: return "UNKNOWN";
  }
}

function mapCoreResult(r: string): UiBuildPhase {
  // core API pakai FAILURE, wfapi pakai FAILED → normalize
  switch (r) {
    case "SUCCESS": return "SUCCESS";
    case "FAILURE": return "FAILED";
    case "ABORTED": return "ABORTED";
    case "UNSTABLE": return "UNSTABLE";
    case "NOT_BUILT": return "NOT_BUILT";
    default: return "UNKNOWN";
  }
}

function currentStageName(stages: any[]): string | undefined {
  const inProgress = stages.find((s) => s?.status === "IN_PROGRESS");
  return inProgress?.name;
}
