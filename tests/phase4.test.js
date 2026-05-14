import assert from "node:assert/strict";
import test from "node:test";
import { closePool, query } from "../packages/db/client.js";
import { migrate } from "../packages/db/migrate.js";
import {
  addTicketDependency,
  claimFiles,
  claimTicket,
  createAgent,
  createProject,
  createTicket,
  getBlockers,
  getFileClaims,
} from "../packages/core/lifecycle.js";
import { patternsOverlap } from "../packages/core/path-locks.js";

test("path overlap detection handles exact and glob claims", () => {
  assert.equal(patternsOverlap("app/*", "app/page.tsx"), true);
  assert.equal(patternsOverlap("components/**", "components/ui/button.tsx"), true);
  assert.equal(patternsOverlap("app/page.tsx", "app/other.tsx"), false);
  assert.equal(patternsOverlap("./app//page.tsx", "app/page.tsx"), true);
});

test("active file claims block overlapping claims and expired claims can be reclaimed", async () => {
  await migrate();
  const namespace = `phase4-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const agentA = await createAgent({ name: "Phase 4 Codex", kind: "codex" });
  const agentB = await createAgent({ name: "Phase 4 Claude", kind: "claude" });
  const project = await createProject({ name: "Phase 4", description: "Locks" });
  const first = await createTicket({
    projectId: project.id,
    actorAgentId: agentA.id,
    title: "Claim app files",
    why: "Prevent concurrent edits",
    description: "Claim a broad path",
  });
  const second = await createTicket({
    projectId: project.id,
    actorAgentId: agentB.id,
    title: "Claim page file",
    why: "Conflict with first",
    description: "Claim an exact path",
  });

  const firstClaim = await claimTicket({ ticketId: first.ticket.id, agentId: agentA.id });
  const secondClaim = await claimTicket({ ticketId: second.ticket.id, agentId: agentB.id });

  await claimFiles({
    ticketId: first.ticket.id,
    agentId: agentA.id,
    leaseToken: firstClaim.leaseToken,
    files: [`${namespace}/app/*`],
    idempotencyKey: `phase4-files-${Date.now()}`,
  });

  await assert.rejects(
    claimFiles({
      ticketId: second.ticket.id,
      agentId: agentB.id,
      leaseToken: secondClaim.leaseToken,
      files: [`${namespace}/app/page.tsx`],
    }),
    /already claimed/,
  );

  await query("UPDATE ticket_file_claims SET expires_at = now() - interval '1 second'");

  const reclaimed = await claimFiles({
    ticketId: second.ticket.id,
    agentId: agentB.id,
    leaseToken: secondClaim.leaseToken,
    files: [`${namespace}/app/page.tsx`],
  });
  assert.equal(reclaimed.claims.length, 1);

  const active = await getFileClaims({ projectId: project.id });
  assert.equal(active.length, 1);
  assert.equal(active[0].normalized_pattern, `${namespace}/app/page.tsx`);
});

test("unfinished dependencies block ticket claims", async () => {
  await migrate();
  const agent = await createAgent({ name: "Phase 4 Dependency Agent", kind: "codex" });
  const project = await createProject({ name: "Phase 4 Dependencies", description: "Blockers" });
  const blocker = await createTicket({
    projectId: project.id,
    actorAgentId: agent.id,
    title: "Blocker",
    why: "Must finish first",
    description: "Dependency ticket",
  });
  const blocked = await createTicket({
    projectId: project.id,
    actorAgentId: agent.id,
    title: "Blocked",
    why: "Depends on blocker",
    description: "Dependent ticket",
  });

  await addTicketDependency({
    ticketId: blocked.ticket.id,
    dependsOnTicketId: blocker.ticket.id,
  });

  const blockers = await getBlockers(blocked.ticket.id);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].title, "Blocker");

  await assert.rejects(
    claimTicket({ ticketId: blocked.ticket.id, agentId: agent.id }),
    /unfinished dependencies/,
  );
});

test.after(async () => {
  await closePool();
});
