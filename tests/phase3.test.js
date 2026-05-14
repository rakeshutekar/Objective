import assert from "node:assert/strict";
import test from "node:test";
import { closePool, query } from "../packages/db/client.js";
import { migrate } from "../packages/db/migrate.js";
import {
  claimTicket,
  createAgent,
  createProject,
  createTicket,
  getTicketEvents,
  recordTest,
  renewTicketLease,
  submitDone,
  updateTicket,
} from "../packages/core/lifecycle.js";

test("ticket lifecycle enforces leases, idempotency, events, and completion gate", async () => {
  await migrate();
  const run = `${Date.now()}-${Math.random()}`;
  const agent = await createAgent({ name: "Phase 3 Codex", kind: "codex" });
  const project = await createProject({ name: "Phase 3", description: "Lifecycle" });

  const created = await createTicket({
    projectId: project.id,
    actorAgentId: agent.id,
    title: "Lifecycle ticket",
    why: "Need lifecycle validation",
    description: "Exercise claim/update/test/done flow",
    plannedFiles: ["apps/web/server.js"],
    testPlan: "Run node tests",
    computerUseRequired: true,
    idempotencyKey: `${run}-create`,
  });

  const duplicate = await createTicket({
    projectId: project.id,
    actorAgentId: agent.id,
    title: "Lifecycle ticket",
    why: "Need lifecycle validation",
    description: "Exercise claim/update/test/done flow",
    plannedFiles: ["apps/web/server.js"],
    testPlan: "Run node tests",
    computerUseRequired: true,
    idempotencyKey: `${run}-create`,
  });

  assert.equal(duplicate.ticket.id, created.ticket.id);

  const claimed = await claimTicket({
    ticketId: created.ticket.id,
    agentId: agent.id,
    idempotencyKey: `${run}-claim`,
  });

  await assert.rejects(
    updateTicket({
      ticketId: created.ticket.id,
      agentId: agent.id,
      leaseToken: "stale-token",
      patch: { proofUrl: "http://localhost:3000" },
    }),
    /Lease token is invalid/,
  );

  await renewTicketLease({
    ticketId: created.ticket.id,
    agentId: agent.id,
    leaseToken: claimed.leaseToken,
  });

  await updateTicket({
    ticketId: created.ticket.id,
    agentId: agent.id,
    leaseToken: claimed.leaseToken,
    patch: {
      actualFilesChanged: ["apps/web/server.js"],
      proofUrl: "http://localhost:3000",
      finalAgentSummary: "Implemented and verified.",
    },
    idempotencyKey: `${run}-update`,
  });

  await recordTest({
    ticketId: created.ticket.id,
    agentId: agent.id,
    leaseToken: claimed.leaseToken,
    command: "npm run test:phase3",
    status: "passed",
    output: "phase3 passed",
    idempotencyKey: `${run}-test`,
  });

  await assert.rejects(
    submitDone({
      ticketId: created.ticket.id,
      agentId: agent.id,
      leaseToken: claimed.leaseToken,
    }),
    /required evidence/,
  );

  const events = await getTicketEvents(created.ticket.id);
  assert.ok(events.some((event) => event.event_type === "ticket.created"));
  assert.ok(events.some((event) => event.event_type === "ticket.claimed"));
  assert.ok(events.some((event) => event.event_type === "test.recorded"));
  assert.ok(events.some((event) => event.event_type === "ticket.completion_rejected"));
});

test("expired lease cannot mutate a ticket", async () => {
  await migrate();
  const agent = await createAgent({ name: "Phase 3 Claude", kind: "claude" });
  const project = await createProject({ name: "Phase 3 Expiry", description: "Lease expiry" });
  const created = await createTicket({
    projectId: project.id,
    actorAgentId: agent.id,
    title: "Expiry ticket",
    why: "Need stale lease rejection",
    description: "Expire the lease manually",
  });
  const claimed = await claimTicket({ ticketId: created.ticket.id, agentId: agent.id });
  await query("UPDATE tickets SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [
    created.ticket.id,
  ]);

  await assert.rejects(
    updateTicket({
      ticketId: created.ticket.id,
      agentId: agent.id,
      leaseToken: claimed.leaseToken,
      patch: { proofUrl: "http://localhost:3000" },
    }),
    /lease has expired/i,
  );
});

test.after(async () => {
  await closePool();
});
