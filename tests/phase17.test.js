import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../packages/core/config.js";
import {
  claimFiles,
  claimTicket,
  createAgent,
  createProject,
  createTicket,
  updateTicket,
} from "../packages/core/lifecycle.js";
import { normalizeDatabaseError } from "../packages/core/validation.js";
import { keepalive } from "../packages/core/workflows.js";
import { closePool, getPool, query } from "../packages/db/client.js";
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

test("ticket lock waits fail fast with actionable errors", async () => {
  await migrate();
  const previousLockTimeoutMs = config.databaseLockTimeoutMs;
  config.databaseLockTimeoutMs = 100;
  const agent = await createAgent({ name: "Phase 17 Lock Agent", kind: "codex" });
  const project = await createProject({ name: "Phase 17 Lock Timeout", description: "Bound lock waits" });
  const created = await createTicket({
    projectId: project.id,
    actorAgentId: agent.id,
    title: "Lock timeout ticket",
    why: "Agents should not wait minutes on row locks",
    description: "Hold the ticket row and verify claim fails quickly.",
  });
  const locker = await getPool().connect();

  try {
    await locker.query("BEGIN");
    await locker.query("SELECT * FROM tickets WHERE id = $1 FOR UPDATE", [created.ticket.id]);
    const startedAt = Date.now();
    await assert.rejects(
      claimTicket({ ticketId: created.ticket.id, agentId: agent.id }),
      (err) => {
        const normalized = normalizeDatabaseError(err);
        assert.equal(normalized.code, "database_lock_timeout");
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 3_000);
  } finally {
    await locker.query("ROLLBACK").catch(() => null);
    locker.release();
    config.databaseLockTimeoutMs = previousLockTimeoutMs;
  }
});

test.after(async () => {
  await closePool();
});
