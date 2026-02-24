import dotenv from "dotenv";
dotenv.config();

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 3001),

  n8n: {
    baseUrl: requireEnv("N8N_DEV_BASE_URL").replace(/\/$/, ""),
    apiVersion: process.env.N8N_DEV_API_VERSION || "v1",
    apiKey: requireEnv("N8N_DEV_API_KEY"),
    insecureTls: String(process.env.N8N_DEV_INSECURE_TLS || "false").toLowerCase() === "true",
  },

  jenkins: {
    baseUrl: requireEnv("JENKINS_BASE_URL").replace(/\/$/, ""),
    user: requireEnv("JENKINS_USER"),
    token: requireEnv("JENKINS_API_TOKEN"),
    jobDevToGit: requireEnv("JENKINS_JOB_DEV_TO_GIT"),
    jobDeployFromGit: requireEnv("JENKINS_JOB_DEPLOY_FROM_GIT"),
    workflowParam: process.env.JENKINS_WORKFLOW_PARAM || "WORKFLOW_ID",
    pollIntervalMs: Number(process.env.JENKINS_POLL_INTERVAL_MS || 2000),
    jobTimeoutMs: Number(process.env.JENKINS_JOB_TIMEOUT_MS || 900000),
  },
};