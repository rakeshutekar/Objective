import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../apps/web/server.js";
import {
  attachArtifact,
  claimTicket,
  createAgent,
  createProject,
  createTicket,
  recordTest,
} from "../packages/core/lifecycle.js";
import { submitDoneWithArtifacts } from "../packages/core/workflows.js";
import { closePool } from "../packages/db/client.js";
import { migrate } from "../packages/db/migrate.js";

async function request(base, path) {
  const response = await fetch(`${base}${path}`, { redirect: "manual" });
  const body = response.headers.get("content-type")?.includes("application/json")
    ? await response.json()
    : null;
  return { response, body };
}

test("artifact attach returns URLs and completion can use latest artifact URL", async () => {
  await migrate();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const agent = await createAgent({ name: "Phase 18 Artifact Agent", kind: "claude" });
    const project = await createProject({ name: "Phase 18 Artifact", description: "Artifact ergonomics" });
    const created = await createTicket({
      projectId: project.id,
      actorAgentId: agent.id,
      title: "Artifact URL ticket",
      why: "Agents need retrievable proof URLs",
      description: "Attach proof and complete using latest artifact URL.",
      plannedFiles: ["phase18-proof.txt"],
    });
    const claimed = await claimTicket({ ticketId: created.ticket.id, agentId: agent.id });
    await recordTest({
      ticketId: created.ticket.id,
      agentId: agent.id,
      leaseToken: claimed.leaseToken,
      command: "phase18 artifact test",
      status: "passed",
    });
    const attached = await attachArtifact({
      ticketId: created.ticket.id,
      agentId: agent.id,
      leaseToken: claimed.leaseToken,
      type: "text-proof",
      filename: "phase18-proof.txt",
      mimeType: "text/plain",
      content: "phase18 proof",
    });

    assert.ok(attached.downloadUrl.includes(`/api/artifacts/${attached.artifact.id}/download`));
    assert.ok(attached.presignedUrl);

    const url = await request(base, `/api/artifacts/${attached.artifact.id}/url`);
    assert.equal(url.response.status, 200);
    assert.ok(url.body.presignedUrl);

    const redirect = await request(base, `/api/artifacts/${attached.artifact.id}/download`);
    assert.equal(redirect.response.status, 302);
    assert.ok(redirect.response.headers.get("location"));

    const done = await submitDoneWithArtifacts({
      ticketId: created.ticket.id,
      agentId: agent.id,
      leaseToken: claimed.leaseToken,
      finalAgentSummary: "Artifact URL test completed.",
      actualFilesChanged: ["phase18-proof.txt"],
    });
    assert.equal(done.ticket.status, "Done");
    assert.ok(done.proofUrl.includes(`/api/artifacts/${attached.artifact.id}/download`));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(async () => {
  await closePool();
});
