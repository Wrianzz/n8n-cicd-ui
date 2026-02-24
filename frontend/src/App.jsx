import { useEffect, useMemo, useState } from "react";
import { fetchWorkflows, pushWorkflowToProd } from "./api";
import "./App.css";

export default function App() {
  const [workflows, setWorkflows] = useState([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState({}); // { [id]: true/false }
  const [status, setStatus] = useState({}); // { [id]: { ok, message, steps } }

  async function load() {
    const data = await fetchWorkflows();
    setWorkflows(data);
  }

  useEffect(() => {
    load().catch((e) => console.error(e));
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return workflows;
    return workflows.filter((w) =>
      String(w.name || "").toLowerCase().includes(needle) ||
      String(w.id || "").toLowerCase().includes(needle)
    );
  }, [q, workflows]);

  async function onPush(id) {
    setBusy((b) => ({ ...b, [id]: true }));
    setStatus((s) => ({ ...s, [id]: { ok: null, message: "Running Jenkins pipeline...", steps: [] } }));

    try {
      const result = await pushWorkflowToProd(id);
      setStatus((s) => ({
        ...s,
        [id]: { ok: true, message: "SUCCESS: pushed to prod", steps: result.steps || [] }
      }));
    } catch (e) {
      const steps = e?.payload?.steps || [];
      setStatus((s) => ({
        ...s,
        [id]: { ok: false, message: e.message || "FAILED", steps }
      }));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  return (
    <div className="page">
      <header className="header">
        <h1>n8n One-Click Promote</h1>
        <div className="toolbar">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or ID..."
          />
          <button onClick={() => load()} className="secondary">Refresh</button>
        </div>
      </header>

      <div className="table">
        <div className="row head">
          <div>ID</div>
          <div>Name</div>
          <div>Active</div>
          <div>Action</div>
          <div>Status</div>
        </div>

        {filtered.map((w) => {
          const s = status[w.id];
          return (
            <div className="row" key={w.id}>
              <div className="mono">{w.id}</div>
              <div>{w.name}</div>
              <div>{w.active ? "Yes" : "No"}</div>
              <div>
                <button
                  disabled={!!busy[w.id]}
                  onClick={() => onPush(w.id)}
                >
                  {busy[w.id] ? "Pushing..." : "Push to Prod"}
                </button>
              </div>
              <div className="status">
                {!s ? (
                  <span className="muted">—</span>
                ) : (
                  <div>
                    <div className={s.ok === true ? "ok" : s.ok === false ? "bad" : "muted"}>
                      {s.message}
                    </div>

                    {Array.isArray(s.steps) && s.steps.length > 0 && (
                      <ul className="steps">
                        {s.steps.map((st, idx) => (
                          <li key={idx}>
                            <span className="mono">{st.job}</span>{" "}
                            <span className={st.result === "SUCCESS" ? "ok" : "bad"}>
                              {st.result}
                            </span>{" "}
                            {st.buildUrl ? (
                              <a href={st.buildUrl} target="_blank" rel="noreferrer">
                                open build
                              </a>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}