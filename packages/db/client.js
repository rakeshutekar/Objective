import pg from "pg";
import { config } from "../core/config.js";

const { Pool } = pg;

let pool;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

export async function query(text, params = []) {
  return getPool().query(text, params);
}

export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (config.databaseLockTimeoutMs > 0) {
      await client.query(`SET LOCAL lock_timeout = '${config.databaseLockTimeoutMs}ms'`);
    }
    if (config.databaseStatementTimeoutMs > 0) {
      await client.query(`SET LOCAL statement_timeout = '${config.databaseStatementTimeoutMs}ms'`);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
