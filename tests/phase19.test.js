import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { createServer } from "../apps/web/server.js";
import { closePool } from "../packages/db/client.js";
import { migrate } from "../packages/db/migrate.js";

function parseToolText(response) {
  assert.equal(response.result?.isError, undefined, response.result?.content?.[0]?.text);
  return JSON.parse(response.result.content[0].text);
}

function parseErrorText(response) {
  assert.equal(response.result?.isError, true);
  return JSON.parse(response.result.content[0].text);
}

async function withMcp(env, fn) {
  const child = spawn(process.execPath, ["apps/mcp-server/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) responses.push(JSON.parse(line));
    }
  });

  let id = 1;
  async function call(name, args = {}) {
    const requestId = id++;
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: { name, arguments: args },
      })}\n`,
    );
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = responses.find((response) => response.id === requestId);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for MCP tool ${name}`);
  }

  try {
    return await fn(call);
  } finally {
    child.kill();
  }
}

test("composed MCP tools complete tickets and roll back failed file claims", async () => {
  await migrate();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const filePath = `phase19-${Date.now()}-${Math.random().toString(36).slice(2)}/feature.ts`;

  try {
    await withMcp({ OBJECTIVE_API_BASE: apiBase }, async (call) => {
      const agent = parseToolText(await call("objective_create_agent", { name: "Phase 19 Agent", kind: "codex" }));
      const project = parseToolText(await call("objective_create_project", { name: "Phase 19", description: "Composed tools" }));
      const firstTicket = parseToolText(
        await call("objective_create_ticket", {
          projectId: project.project.id,
          actorAgentId: agent.agent.id,
          title: "Hold file",
          why: "Create file conflict",
          description: "Claim a file so rollback can be verified.",
          plannedFiles: [filePath],
        }),
      );
      const firstClaim = parseToolText(
        await call("objective_claim_ticket_and_files", {
          ticketId: firstTicket.ticket.id,
          agentId: agent.agent.id,
          files: [filePath],
        }),
      );
      assert.ok(firstClaim.lease.leaseToken);

      const conflictTicket = parseToolText(
        await call("objective_create_ticket", {
          projectId: project.project.id,
          actorAgentId: agent.agent.id,
          title: "Conflict file",
          why: "Verify rollback",
          description: "Composed claim should release this ticket on conflict.",
          plannedFiles: [filePath],
        }),
      );
      const conflict = parseErrorText(
        await call("objective_claim_ticket_and_files", {
          ticketId: conflictTicket.ticket.id,
          agentId: agent.agent.id,
          files: [filePath],
        }),
      );
      assert.equal(conflict.error, "file_claim_conflict");
      assert.equal(conflict.details.ticketClaimRolledBack, true);

      const readConflict = parseToolText(await call("objective_get_ticket", { ticketId: conflictTicket.ticket.id }));
      assert.equal(readConflict.ticket.assignedAgentId, null);

      const doneTicket = parseToolText(
        await call("objective_create_ticket", {
          projectId: project.project.id,
          actorAgentId: agent.agent.id,
          title: "Complete with composed tools",
          why: "Verify one-shot workflow helpers",
          description: "Claim, test, attach proof, and submit done.",
          plannedFiles: [`${filePath}.done`],
        }),
      );
      const doneClaim = parseToolText(
        await call("objective_claim_ticket_and_files", {
          ticketId: doneTicket.ticket.id,
          agentId: agent.agent.id,
          files: [`${filePath}.done`],
        }),
      );
      const testRun = parseToolText(
        await call("objective_record_test_and_attach_log", {
          ticketId: doneTicket.ticket.id,
          agentId: agent.agent.id,
          leaseToken: doneClaim.lease.leaseToken,
          command: "phase19 composed test",
          status: "passed",
          output: "phase19 composed test passed",
        }),
      );
      assert.equal(testRun.ok, true);

      const done = parseToolText(
        await call("objective_submit_done_with_artifacts", {
          ticketId: doneTicket.ticket.id,
          agentId: agent.agent.id,
          leaseToken: doneClaim.lease.leaseToken,
          finalAgentSummary: "Composed MCP workflow completed.",
          actualFilesChanged: [`${filePath}.done`],
        }),
      );
      assert.equal(done.ticket.status, "Done");
      assert.ok(done.proofUrl.includes("/api/artifacts/"));
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(async () => {
  await closePool();
});
