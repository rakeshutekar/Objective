import assert from "node:assert/strict";
import test from "node:test";
import { closePool } from "../packages/db/client.js";
import { migrate } from "../packages/db/migrate.js";
import {
  attachArtifact,
  claimTicket,
  createAgent,
  createProject,
  createTicket,
  getArtifactUrl,
  listProofArtifacts,
  recordTest,
  submitDone,
  updateTicket,
} from "../packages/core/lifecycle.js";
import { ensureBucket } from "../packages/storage/minio.js";

test("proof artifacts are stored and satisfy completion gate", async () => {
  await migrate();
  await ensureBucket();

  const agent = await createAgent({ name: "Phase 5 Agent", kind: "codex" });
  const project = await createProject({ name: "Phase 5", description: "Artifacts" });
  const created = await createTicket({
    projectId: project.id,
    actorAgentId: agent.id,
    title: "Artifact ticket",
    why: "Need proof storage",
    description: "Attach artifact proof and finish",
    plannedFiles: ["apps/web/public/index.html"],
    testPlan: "Run phase 5 tests",
  });
  const claimed = await claimTicket({ ticketId: created.ticket.id, agentId: agent.id });

  await updateTicket({
    ticketId: created.ticket.id,
    agentId: agent.id,
    leaseToken: claimed.leaseToken,
    patch: {
      actualFilesChanged: ["apps/web/public/index.html"],
      proofUrl: "http://localhost:3000",
      finalAgentSummary: "Attached local proof and ran tests.",
    },
  });

  await recordTest({
    ticketId: created.ticket.id,
    agentId: agent.id,
    leaseToken: claimed.leaseToken,
    command: "npm run test:phase5",
    status: "passed",
    output: "phase 5 passed",
  });

  const attached = await attachArtifact({
    ticketId: created.ticket.id,
    agentId: agent.id,
    leaseToken: claimed.leaseToken,
    type: "screenshot",
    filename: "phase5-proof.txt",
    mimeType: "text/plain",
    content: "Objective proof artifact",
    label: "Phase 5 proof",
  });
  assert.ok(attached.artifact.id);
  assert.ok(attached.object.checksum);

  const artifacts = await listProofArtifacts(created.ticket.id);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].filename, "phase5-proof.txt");

  const url = await getArtifactUrl(artifacts[0].object_key);
  assert.match(url, /^http/);

  const done = await submitDone({
    ticketId: created.ticket.id,
    agentId: agent.id,
    leaseToken: claimed.leaseToken,
  });
  assert.equal(done.ticket.status, "Done");
});

test.after(async () => {
  await closePool();
});
