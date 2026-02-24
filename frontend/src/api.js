export async function fetchWorkflows() {
  const res = await fetch("/api/workflows");
  if (!res.ok) throw new Error(`Failed to fetch workflows: ${res.status}`);
  const json = await res.json();
  return json.data || [];
}

export async function pushWorkflowToProd(workflowId) {
  const res = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/push`, {
    method: "POST"
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error || `Push failed: ${res.status}`;
    const err = new Error(msg);
    err.payload = json;
    throw err;
  }
  return json;
}