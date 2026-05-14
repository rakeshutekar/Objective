import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../apps/web/server.js";
import { closePool } from "../packages/db/client.js";
import { migrate } from "../packages/db/migrate.js";

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const body = await response.json();
  return { response, body };
}

test("API returns actionable validation errors for invalid IDs", async () => {
  await migrate();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const ticket = await request(base, "/api/tickets/not-a-uuid");
    assert.equal(ticket.response.status, 400);
    assert.equal(ticket.body.error, "invalid_ticket_id_format");
    assert.equal(ticket.body.details.field, "ticketId");

    const project = await request(base, "/api/projects/not-a-uuid/tickets");
    assert.equal(project.response.status, 400);
    assert.equal(project.body.error, "invalid_project_id_format");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(async () => {
  await closePool();
});
