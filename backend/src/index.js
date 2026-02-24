import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { workflowsRouter } from "./routes/workflows.js";
import { jenkinsRouter } from "./routes/jenkins.js";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/workflows", workflowsRouter);
app.use("/api/jenkins", jenkinsRouter);

// ADD: JSON 404 for /api/*
app.use("/api", (req, res) => {
  res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
});

// ADD: JSON error handler
app.use((err, req, res, next) => {
  res.status(500).json({ error: err?.message || String(err) });
});

app.listen(config.port, () => {
  console.log(`[backend] listening on :${config.port}`);
});