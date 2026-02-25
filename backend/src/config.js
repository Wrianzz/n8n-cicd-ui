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
    jobPromoteCreds: requireEnv("JENKINS_JOB_PROMOTE_CREDS"),
    credIdsParam: process.env.JENKINS_CRED_IDS_PARAM || "CRED_IDS",
  },

  db: {
    host: requireEnv("N8N_DEV_DB_HOST"),
    port: Number(process.env.N8N_DEV_DB_PORT || 5432),
    database: requireEnv("N8N_DEV_DB_NAME"),
    user: requireEnv("N8N_DEV_DB_USER"),
    password: requireEnv("N8N_DEV_DB_PASSWORD"),
    ssl: String(process.env.N8N_DEV_DB_SSL || "false").toLowerCase() === "true",
  },

  prodDb: {
    host: requireEnv("N8N_PROD_DB_HOST"),
    port: Number(process.env.N8N_PROD_DB_PORT || 5432),
    database: requireEnv("N8N_PROD_DB_NAME"),
    user: requireEnv("N8N_PROD_DB_USER"),
    password: requireEnv("N8N_PROD_DB_PASSWORD"),
    ssl: String(process.env.N8N_PROD_DB_SSL || "false").toLowerCase() === "true",
  },
};
