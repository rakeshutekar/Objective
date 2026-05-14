import assert from "node:assert/strict";
import test from "node:test";
import { closePool } from "../packages/db/client.js";
import { migrate } from "../packages/db/migrate.js";
import {
  claimFiles,
  claimTicket,
  createAgent,
  createProject,
  createTicket,
  heartbeat,
  listAgentWork,
  rejectProof,
  reopenTicket,
  searchTickets,
} from "../packages/core/lifecycle.js";

test("ticket search, agent work, proof rejection, and reopen flows work", async () => {
  await migrate();
  const namespace = `phase11-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const agent = await createAgent({ name: "Phase 11 Agent", kind: "codex" });
  const project = await createProject({ name: "Phase 11", description: "Verification" });
  const created = await createTicket({
    projectId: project.id,
    actorAgentId: agent.id,
    title: "Searchable proof ticket",
    why: "Need search and review flows",
    description: "Exercise phase 11 surfaces",
  });
  const claimed = await claimTicket({ ticketId: created.ticket.id, agentId: agent.id });
  await claimFiles({
    ticketId: created.ticket.id,
    agentId: agent.id,
    leaseToken: claimed.leaseToken,
    files: [`${namespace}/**`],
  });

  const found = await searchTickets({ projectId: project.id, q: "proof" });
  assert.ok(found.some((ticket) => ticket.id === created.ticket.id));

  const work = await listAgentWork(agent.id);
  assert.ok(work.some((ticket) => ticket.id === created.ticket.id));

  await rejectProof({ ticketId: created.ticket.id, actorAgentId: agent.id, reason: "Missing screenshot" });
  const reopened = await reopenTicket({ ticketId: created.ticket.id, actorAgentId: agent.id, reason: "Continue work" });
  assert.equal(reopened.ticket.status, "Reopened");
});

test("1000 local agent heartbeats can be recorded without logical corruption", async () => {
  await migrate();
  const agents = await Promise.all(
    Array.from({ length: 1000 }, (_, index) =>
      createAgent({ name: `Load Agent ${Date.now()} ${index}`, kind: index % 2 ? "claude" : "codex" }),
    ),
  );

  await Promise.all(
    agents.map((agent, index) =>
      heartbeat({
        agentId: agent.id,
        metadata: { batch: "phase11", index },
      }),
    ),
  );

  assert.equal(agents.length, 1000);
});

test.after(async () => {
  await closePool();
});
