import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { workflowsRouter } from "./routes/workflows.js";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/workflows", workflowsRouter);

app.listen(config.port, () => {
  console.log(`[backend] listening on :${config.port}`);
});