import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../apps/web/server.js";
import { closePool } from "../packages/db/client.js";
import { migrate } from "../packages/db/migrate.js";

const auth = { authorization: "Bearer dev-agent-key", "content-type": "application/json" };

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { ...(options.headers ?? {}), ...(options.body ? auth : {}) },
  });
  const body = await response.json();
  return { response, body };
}

test("core API supports project and ticket workflow", async () => {
  await migrate();
  const filePath = `phase6-${Date.now()}-${Math.random().toString(36).slice(2)}/api.js`;
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const health = await request(base, "/api/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.body.database, "ok");

    const agent = await request(base, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Phase 6 API Agent", kind: "codex" }),
    });
    assert.equal(agent.response.status, 201);

    const project = await request(base, "/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Phase 6 API", description: "API verification" }),
    });
    assert.equal(project.response.status, 201);

    const ticket = await request(base, "/api/tickets", {
      method: "POST",
      body: JSON.stringify({
        projectId: project.body.project.id,
        actorAgentId: agent.body.agent.id,
        title: "API ticket",
        why: "Verify API",
        description: "Exercise API endpoints",
        plannedFiles: [filePath],
      }),
    });
    assert.equal(ticket.response.status, 201);

    const claim = await request(base, `/api/tickets/${ticket.body.ticket.id}/claim`, {
      method: "POST",
      body: JSON.stringify({ agentId: agent.body.agent.id }),
    });
    assert.equal(claim.response.status, 200);
    assert.ok(claim.body.leaseToken);

    const files = await request(base, `/api/tickets/${ticket.body.ticket.id}/files/claim`, {
      method: "POST",
      body: JSON.stringify({
        agentId: agent.body.agent.id,
        leaseToken: claim.body.leaseToken,
        files: [filePath],
      }),
    });
    assert.equal(files.response.status, 200);
    assert.equal(files.body.claims.length, 1);

    const events = await request(base, `/api/tickets/${ticket.body.ticket.id}/events`);
    assert.equal(events.response.status, 200);
    assert.ok(events.body.events.length >= 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(async () => {
  await closePool();
});
