import assert from "node:assert/strict";
import test from "node:test";
import {
  claimFiles,
  claimTicket,
  createAgent,
  createProject,
  createTicket,
  updateTicket,
} from "../packages/core/lifecycle.js";
import { keepalive } from "../packages/core/workflows.js";
import { closePool, query } from "../packages/db/client.js";
import { migrate } from "../packages/db/migrate.js";

test("claimed ticket mutations expose and extend lease hints", async () => {
  await migrate();
  const filePath = `phase17-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`;
  const agent = await createAgent({ name: "Phase 17 Lease Agent", kind: "codex" });
  const project = await createProject({ name: "Phase 17 Lease", description: "Lease ergonomics" });
  const created = await createTicket({
    projectId: project.id,
    actorAgentId: agent.id,
    title: "Lease extension ticket",
    why: "Agents need long-running work support",
    description: "Exercise lease metadata and keepalive.",
  });

  const claimed = await claimTicket({ ticketId: created.ticket.id, agentId: agent.id });
  assert.ok(claimed.leaseToken);
  assert.equal(claimed.leaseTtlSeconds, 900);
  assert.ok(claimed.renewAt);

  await query("UPDATE tickets SET lease_expires_at = now() + interval '30 seconds' WHERE id = $1", [
    created.ticket.id,
  ]);
  const updated = await updateTicket({
    ticketId: created.ticket.id,
    agentId: agent.id,
    leaseToken: claimed.leaseToken,
    patch: { actualFilesChanged: [filePath] },
  });
  assert.ok(new Date(updated.ticket.leaseExpiresAt).getTime() > Date.now() + 10 * 60 * 1000);
  assert.ok(updated.lease.renewAt);

  const files = await claimFiles({
    ticketId: created.ticket.id,
    agentId: agent.id,
    leaseToken: claimed.leaseToken,
    files: [filePath],
  });
  assert.equal(files.claims.length, 1);
  assert.ok(new Date(files.claims[0].expires_at).getTime() > Date.now() + 10 * 60 * 1000);

  const alive = await keepalive({
    agentId: agent.id,
    ticketId: created.ticket.id,
    leaseToken: claimed.leaseToken,
  });
  assert.ok(alive.heartbeat.id);
  assert.equal(alive.lease.leaseToken, claimed.leaseToken);
});

test.after(async () => {
  await closePool();
});
