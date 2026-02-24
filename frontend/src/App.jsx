import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchWorkflows,
  getJenkinsBuildStatus,
  pushWorkflowToGit,
  pushWorkflowToProd,
} from "./api";

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

function statusColor(state) {
  switch (state) {
    case "RUNNING":
      return "text-blue-700";
    case "AWAITING_APPROVAL":
      return "text-amber-700";
    case "SUCCESS":
      return "text-green-700";
    case "FAILED":
      return "text-red-700";
    default:
      return "text-slate-500";
  }
}

export default function App() {
  const [workflows, setWorkflows] = useState([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState({}); // { [id]: { git?:bool, prod?:bool } }
  const [deploy, setDeploy] = useState({}); // { [id]: { label, state, steps } }
  const pollersRef = useRef({}); // { [id]: intervalId }

  async function load() {
    const data = await fetchWorkflows();
    setWorkflows(data);
  }

  useEffect(() => {
    load().catch(console.error);
    return () => {
      for (const k of Object.keys(pollersRef.current)) clearInterval(pollersRef.current[k]);
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return workflows;
    return workflows.filter(
      (w) =>
        String(w.name || "").toLowerCase().includes(needle) ||
        String(w.id || "").toLowerCase().includes(needle)
    );
  }, [q, workflows]);

  function setBusyFlag(id, key, val) {
    setBusy((b) => ({ ...b, [id]: { ...(b[id] || {}), [key]: val } }));
  }

  function startPollingIfNeeded(id, step2BuildUrl) {
    if (pollersRef.current[id]) return;

    const intervalId = setInterval(async () => {
      try {
        const st = await getJenkinsBuildStatus(step2BuildUrl);

        if (st.state === "AWAITING_APPROVAL") {
          setDeploy((d) => ({
            ...d,
            [id]: { ...(d[id] || {}), state: "AWAITING_APPROVAL", label: "Awaiting approval" },
          }));
          return;
        }

        if (st.state === "FINISHED") {
          setDeploy((d) => ({
            ...d,
            [id]: {
              ...(d[id] || {}),
              state: st.result === "SUCCESS" ? "SUCCESS" : "FAILED",
              label: st.result === "SUCCESS" ? "Deployed to prod" : `Deploy failed: ${st.result}`,
            },
          }));
          clearInterval(intervalId);
          delete pollersRef.current[id];
        }
      } catch {
        clearInterval(intervalId);
        delete pollersRef.current[id];
      }
    }, 2500);

    pollersRef.current[id] = intervalId;
  }

  async function onPushGit(id) {
    setBusyFlag(id, "git", true);
    setDeploy((d) => ({ ...d, [id]: { state: "RUNNING", label: "Pushing to Git...", steps: [] } }));

    try {
      const result = await pushWorkflowToGit(id);
      setDeploy((d) => ({ ...d, [id]: { state: "SUCCESS", label: "Pushed to Git", steps: result.steps || [] } }));
    } catch (e) {
      setDeploy((d) => ({ ...d, [id]: { state: "FAILED", label: e.message || "Push to Git failed", steps: e?.payload?.steps || [] } }));
    } finally {
      setBusyFlag(id, "git", false);
    }
  }

  async function onPushProd(id) {
    setBusyFlag(id, "prod", true);
    setDeploy((d) => ({ ...d, [id]: { state: "RUNNING", label: "Promoting to prod...", steps: [] } }));

    try {
      const result = await pushWorkflowToProd(id);
      const steps = result.steps || [];
      const step2 = steps[1];

      if (result.state === "AWAITING_APPROVAL") {
        setDeploy((d) => ({ ...d, [id]: { state: "AWAITING_APPROVAL", label: "Awaiting approval", steps } }));
        if (step2?.buildUrl) startPollingIfNeeded(id, step2.buildUrl);
        return;
      }

      setDeploy((d) => ({ ...d, [id]: { state: "SUCCESS", label: "Deployed to prod", steps } }));
    } catch (e) {
      setDeploy((d) => ({ ...d, [id]: { state: "FAILED", label: e.message || "Push to prod failed", steps: e?.payload?.steps || [] } }));
    } finally {
      setBusyFlag(id, "prod", false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Sidebar: sticky + h-screen */}
      <aside className="w-64 shrink-0 h-screen sticky top-0 bg-slate-950 text-slate-100 flex flex-col">
        <div className="px-5 pt-5 pb-4 flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-orange-500 grid place-items-center font-extrabold">
            n8n
          </div>
          <div className="font-semibold">Control Plane</div>
        </div>

        <nav className="px-3 flex flex-col gap-2">
          <div className="px-3 py-2 rounded-xl bg-orange-500/15 border border-orange-500/30 flex items-center gap-3">
            <span className="text-sm">📄</span>
            <span className="text-sm font-semibold">Workflows</span>
          </div>

          <div className="px-3 py-2 rounded-xl opacity-60 cursor-not-allowed flex items-center gap-3">
            <span className="text-sm">🔒</span>
            <span className="text-sm font-semibold">Credentials</span>
          </div>
        </nav>

        <div className="mt-auto p-4">
          <div className="rounded-2xl bg-white/5 border border-white/10 p-3 flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-white/10 grid place-items-center font-bold">JD</div>
            <div>
              <div className="text-sm font-semibold">John Doe</div>
              <div className="text-xs text-slate-300">DevOps Engineer</div>
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 p-6 overflow-x-auto">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold text-slate-900">Workflows</h1>
          <span className="text-xs font-semibold px-3 py-1 rounded-full border border-green-200 bg-green-50 text-green-700">
            System Operational
          </span>
        </div>

        <section className="bg-white border border-slate-200 rounded-2xl">
          <div className="p-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 font-bold text-slate-900">
              <span className="text-red-500">⟟</span> Dev Workflows
            </div>

            <div className="flex items-center gap-3">
              <div className="relative w-[320px]">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">🔎</span>
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search workflows..."
                  className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-slate-200"
                />
              </div>

              <button
                onClick={() => load()}
                className="px-4 py-2 text-sm font-semibold rounded-xl border border-slate-200 bg-white hover:bg-slate-50"
              >
                Refresh
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="border-t border-slate-200">
            {/* Header */}
            <div className="grid grid-cols-[160px_1fr_160px_300px_260px] gap-3 px-4 py-3 text-xs font-bold text-slate-500 text-center">
              <div>Status</div>
              <div>Name</div>
              <div>Last Updated</div>
              <div>Actions</div>
              <div>Details</div>
            </div>
          
            <div className="divide-y divide-slate-200">
              {filtered.map((w) => {
                const d = deploy[w.id];
                const isActive = !!w.active;
              
                const buildLinks =
                  Array.isArray(d?.steps)
                    ? d.steps
                        .filter((s) => s?.buildUrl)
                        .map((s, idx) => ({
                          label: idx === 0 ? "Dev→Git build" : "Deploy build",
                          url: s.buildUrl,
                        }))
                    : [];
                      
                return (
                  <div
                    key={w.id}
                    className="grid grid-cols-[160px_1fr_160px_300px_260px] gap-3 px-4 py-3 items-center"
                  >
                    {/* Status */}
                    <div className="flex items-center gap-2 justify-center">
                      <span className={`h-2.5 w-2.5 rounded-full ${isActive ? "bg-green-500" : "bg-slate-300"}`} />
                      <span className={`text-sm font-semibold ${isActive ? "text-green-700" : "text-slate-500"}`}>
                        {isActive ? "Active" : "Inactive"}
                      </span>
                    </div>
              
                    {/* Name */}
                    <div>
                      <div className="text-sm font-extrabold text-slate-900">{w.name}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        <span className="font-mono">ID: {w.id}</span>
                      </div>
                    </div>
              
                    {/* Updated */}
                    <div className="text-sm text-slate-700 items-center text-center">{formatDate(w.updatedAt)}</div>
              
                    {/* Actions (tombol saja, sejajar) */}
                    <div className="flex items-center justify-center gap-3 ">
                      <button
                        onClick={() => onPushGit(w.id)}
                        disabled={!!busy[w.id]?.git}
                        className="px-4 py-2 text-sm font-bold rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {busy[w.id]?.git ? "Pushing..." : "Push to Git"}
                      </button>
              
                      <button
                        onClick={() => onPushProd(w.id)}
                        disabled={!!busy[w.id]?.prod}
                        className="px-4 py-2 text-sm font-bold rounded-xl bg-green-600 text-white hover:bg-green-700 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {busy[w.id]?.prod ? "Promoting..." : "Push to Prod"}
                      </button>
                    </div>
              
                    {/* Keterangan (kolom khusus) */}
                    <div className="text-sm text-center">
                      {!d?.label ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          <span className={`font-semibold ${statusColor(d.state)}`}>{d.label}</span>
                      
                          {buildLinks.length > 0 ? (
                            <div className="text-xs">
                              {buildLinks.slice(0, 2).map((b, idx) => (
                                <a
                                  key={idx}
                                  href={b.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-blue-600 hover:underline mr-3"
                                >
                                  {b.label}
                                </a>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}