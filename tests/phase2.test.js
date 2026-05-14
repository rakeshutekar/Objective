import assert from "node:assert/strict";
import test from "node:test";
import { closePool, query } from "../packages/db/client.js";
import { migrate } from "../packages/db/migrate.js";

test("schema creates core tables and rejects dependency cycles", async () => {
  await migrate();

  const project = await query(
    "INSERT INTO projects(name, description) VALUES ($1, $2) RETURNING id",
    ["Phase 2 Project", "Schema verification"],
  );

  const first = await query(
    `
      INSERT INTO tickets(project_id, title, why, description, status)
      VALUES ($1, $2, $3, $4, 'Ready')
      RETURNING id
    `,
    [project.rows[0].id, "First", "Need first", "First ticket"],
  );

  const second = await query(
    `
      INSERT INTO tickets(project_id, title, why, description, status)
      VALUES ($1, $2, $3, $4, 'Ready')
      RETURNING id
    `,
    [project.rows[0].id, "Second", "Need second", "Second ticket"],
  );

  await query(
    "INSERT INTO ticket_dependencies(ticket_id, depends_on_ticket_id) VALUES ($1, $2)",
    [first.rows[0].id, second.rows[0].id],
  );

  await assert.rejects(
    query("INSERT INTO ticket_dependencies(ticket_id, depends_on_ticket_id) VALUES ($1, $2)", [
      second.rows[0].id,
      first.rows[0].id,
    ]),
    /cycle/i,
  );

  const tables = await query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `,
  );

  const names = tables.rows.map((row) => row.table_name);
  assert.ok(names.includes("tickets"));
  assert.ok(names.includes("ticket_events"));
  assert.ok(names.includes("proof_artifacts"));
  assert.ok(names.includes("idempotency_keys"));
});

test.after(async () => {
  await closePool();
});
