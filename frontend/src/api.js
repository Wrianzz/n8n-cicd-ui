async function readBody(res) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();

  if (ct.includes("application/json")) {
    return await res.json();
  }

  const text = await res.text();
  return { __nonJson: true, text };
}

function toErrorMessage(res, payload) {
  if (payload?.__nonJson) {
    const snippet = payload.text?.slice(0, 180)?.replace(/\s+/g, " ");
    return `Non-JSON response (${res.status}). Snippet: ${snippet}`;
  }
  return payload?.error || `Request failed: ${res.status}`;
}

async function request(url, init) {
  const res = await fetch(url, init);
  const payload = await readBody(res);
  if (!res.ok) {
    const err = new Error(toErrorMessage(res, payload));
    err.payload = payload;
    throw err;
  }
  return payload;
}

export async function fetchWorkflows() {
  const payload = await request("/api/workflows");
  return payload.data || [];
}

export async function fetchWorkflowCredentialsDiff(workflowId) {
  return await request(`/api/workflows/${encodeURIComponent(workflowId)}/credentials-diff`);
}

export async function pushWorkflowToProd(workflowId) {
  return await request(`/api/workflows/${encodeURIComponent(workflowId)}/push`, { method: "POST" });
}

export async function pushWorkflowToGit(workflowId) {
  return await request(`/api/workflows/${encodeURIComponent(workflowId)}/push-git`, { method: "POST" });
}

export async function pullWorkflowFromGit(workflowId) {
  return await request(`/api/workflows/${encodeURIComponent(workflowId)}/pull-git`, { method: "POST" });
}

export async function getJenkinsBuildStatus(buildUrl) {
  const u = new URL("/api/jenkins/build-status", window.location.origin);
  u.searchParams.set("buildUrl", buildUrl);
  return await request(u.toString());
}

export async function fetchCredentials(q = "") {
  const u = new URL("/api/credentials", window.location.origin);
  if (q) u.searchParams.set("q", q);

  const payload = await request(u.toString());
  return payload.data || [];
}

export async function promoteCredentials(ids) {
  return await request("/api/credentials/promote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

export async function fetchDashboardSummary({ days = 7, healthStatus = "ALL" } = {}) {
  const u = new URL("/api/dashboard/summary", window.location.origin);
  u.searchParams.set("days", String(days));
  u.searchParams.set("healthStatus", String(healthStatus));
  return await request(u.toString());
}
