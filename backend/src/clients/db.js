import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

function createPool(dbConfig) {
  return new Pool({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    ssl: dbConfig.ssl ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30000,
  });
}

export const pool = createPool(config.db);
export const prodPool = createPool(config.prodDb);
