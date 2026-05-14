import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, query } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const migrations = [
    ["001_initial", join(__dirname, "migrations", "001_initial.sql")],
  ];

  for (const [version, path] of migrations) {
    const existing = await query("SELECT 1 FROM schema_migrations WHERE version = $1", [
      version,
    ]);
    if (existing.rowCount > 0) continue;
    const sql = await readFile(path, "utf8");
    await query(sql);
    await query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
    console.log(`Applied migration ${version}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => closePool())
    .catch(async (err) => {
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
