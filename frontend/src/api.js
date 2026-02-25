async function readBody(res) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();

  // JSON normal
  if (ct.includes("application/json")) {
    return await res.json();
  }

  // Non-JSON (HTML/teks)
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

export async function fetchWorkflows() {
  const res = await fetch("/api/workflows");
  const payload = await readBody(res);
  if (!res.ok) throw new Error(toErrorMessage(res, payload));
  return payload.data || [];
}

export async function pushWorkflowToProd(workflowId) {
  const res = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/push`, { method: "POST" });
  const payload = await readBody(res);
  if (!res.ok) {
    const err = new Error(toErrorMessage(res, payload));
    err.payload = payload;
    throw err;
  }
  return payload;
}

export async function pushWorkflowToGit(workflowId) {
  const res = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/push-git`, { method: "POST" });
  const payload = await readBody(res);
  if (!res.ok) {
    const err = new Error(toErrorMessage(res, payload));
    err.payload = payload;
    throw err;
  }
  return payload;
}

export async function getJenkinsBuildStatus(buildUrl) {
  const u = new URL("/api/jenkins/build-status", window.location.origin);
  u.searchParams.set("buildUrl", buildUrl);

  const res = await fetch(u.toString());
  const payload = await readBody(res);
  if (!res.ok) throw new Error(toErrorMessage(res, payload));
  return payload;
}