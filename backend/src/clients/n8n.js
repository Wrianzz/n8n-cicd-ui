import axios from "axios";
import https from "https";
import { config } from "../config.js";

const httpsAgent = config.n8n.insecureTls
  ? new https.Agent({ rejectUnauthorized: false })
  : undefined;

const n8n = axios.create({
  baseURL: config.n8n.baseUrl,
  timeout: 20000,
  httpsAgent,
});

n8n.interceptors.request.use((req) => {
  req.headers["accept"] = "application/json";
  req.headers["X-N8N-API-KEY"] = config.n8n.apiKey; // sesuai docs :contentReference[oaicite:8]{index=8}
  return req;
});

export async function listAllWorkflows() {
  const apiBase = `/api/${config.n8n.apiVersion}/workflows`;

  const limit = 250; // max 250 :contentReference[oaicite:9]{index=9}
  let cursor = null;
  const all = [];

  while (true) {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);

    const url = `${apiBase}?${params.toString()}`;
    const res = await n8n.get(url);

    const data = res.data?.data ?? [];
    all.push(...data);

    cursor = res.data?.nextCursor ?? null;
    if (!cursor) break;
  }

  // Normalisasi agar frontend simpel
  return all.map((w) => ({
    id: w.id,
    name: w.name,
    active: w.active,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  }));
}