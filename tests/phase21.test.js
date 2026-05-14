import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import test from "node:test";
import { createServer } from "../apps/web/server.js";
import { config, normalizeApiBase } from "../packages/core/config.js";
import { closePool } from "../packages/db/client.js";
import { migrate } from "../packages/db/migrate.js";

function parseToolText(response) {
  assert.equal(response.result?.isError, undefined, response.result?.content?.[0]?.text);
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
    for (let attempt = 0; attempt < 300; attempt += 1) {
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

test("agent tool ergonomics handle artifact aliases, sessions, flat logs, and reopen cleanup", async () => {
  await migrate();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const apiBase = `http://localhost:${server.address().port}`;
  const previousApiBase = config.apiBase;
  config.apiBase = normalizeApiBase(apiBase);
  const unique = `phase21-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    await withMcp({ OBJECTIVE_API_BASE: apiBase }, async (call) => {
      const agent = parseToolText(await call("objective_create_agent", { name: "Phase 21 Agent", kind: "codex" }));
      const project = parseToolText(await call("objective_create_project", { name: `Phase 21 ${unique}` }));
      const ticket = parseToolText(
        await call("objective_create_ticket", {
          projectId: project.project.id,
          actorAgentId: agent.agent.id,
          title: "Phase 21 ergonomics",
          why: "Cover full tool feedback regressions",
          description: "Exercise artifact aliases, session IDs, flat log response, and reopen cleanup.",
          plannedFiles: [`${unique}/feature.ts`],
        }),
      );
      const claim = parseToolText(
        await call("objective_claim_ticket_and_files", {
          ticketId: ticket.ticket.id,
          agentId: agent.agent.id,
          files: [`${unique}/feature.ts`],
        }),
      );

      const logArtifact = parseToolText(
        await call("objective_attach_artifact", {
          ticketId: ticket.ticket.id,
          agentId: agent.agent.id,
          leaseToken: claim.lease.leaseToken,
          type: "log",
          filename: "phase21.log",
          mimeType: "text/plain",
          content: "phase21 log artifact",
        }),
      );
      assert.equal(logArtifact.artifact.type, "test-log");
      assert.ok(logArtifact.downloadUrl.startsWith("http://127.0.0.1:"));
      assert.equal(logArtifact.downloadUrl.includes("localhost"), false);

      const proofArtifact = parseToolText(
        await call("objective_attach_artifact", {
          ticketId: ticket.ticket.id,
          agentId: agent.agent.id,
          leaseToken: claim.lease.leaseToken,
          type: "proof",
          filename: "phase21-proof.txt",
          mimeType: "text/plain",
          content: "phase21 proof artifact",
          idempotencyKey: `${unique}:proof`,
        }),
      );
      assert.equal(proofArtifact.artifact.type, "text-proof");

      const heartbeat = parseToolText(
        await call("objective_heartbeat", {
          agentId: agent.agent.id,
          sessionId: "phase21-human-session",
          metadata: { phase: 21 },
        }),
      );
      assert.equal(heartbeat.heartbeat.sessionLabel, "phase21-human-session");
      assert.ok(heartbeat.heartbeat.session_id);

      const uuidSessionId = randomUUID();
      const uuidHeartbeat = parseToolText(
        await call("objective_heartbeat", {
          agentId: agent.agent.id,
          sessionId: uuidSessionId,
        }),
      );
      assert.equal(uuidHeartbeat.heartbeat.session_id, uuidSessionId);

      const keepalive = parseToolText(
        await call("objective_keepalive", {
          agentId: agent.agent.id,
          ticketId: ticket.ticket.id,
          leaseToken: claim.lease.leaseToken,
          sessionId: "phase21-keepalive-session",
        }),
      );
      assert.equal(keepalive.heartbeat.sessionLabel, "phase21-keepalive-session");
      assert.equal(keepalive.lease.leaseToken, claim.lease.leaseToken);

      const log = parseToolText(
        await call("objective_record_test_and_attach_log", {
          ticketId: ticket.ticket.id,
          agentId: agent.agent.id,
          leaseToken: claim.lease.leaseToken,
          command: "phase21 ergonomic test",
          status: "passed",
          output: "phase21 ergonomic test passed",
        }),
      );
      assert.equal(log.ok, true);
      assert.ok(log.testRun.id);
      assert.ok(log.artifact.id);
      assert.equal(log.artifact.artifact, undefined);
      assert.ok(log.lease.leaseToken);
      assert.ok(log.downloadUrl.startsWith("http://127.0.0.1:"));

      await call("objective_attach_screenshot", {
        ticketId: ticket.ticket.id,
        agentId: agent.agent.id,
        leaseToken: claim.lease.leaseToken,
        filename: "phase21-screenshot.txt",
        mimeType: "text/plain",
        content: "fake screenshot proof",
      });
      await call("objective_reject_proof", {
        ticketId: ticket.ticket.id,
        actorAgentId: agent.agent.id,
        reason: "phase21 rejection",
      });
      const reopened = parseToolText(
        await call("objective_reopen_ticket", {
          ticketId: ticket.ticket.id,
          actorAgentId: agent.agent.id,
          reason: "phase21 reopen",
        }),
      );
      assert.equal(reopened.ticket.assignedAgentId, null);
      assert.equal(reopened.ticket.leaseToken, null);

      const claims = parseToolText(
        await call("objective_get_file_claims", {
          ticketId: ticket.ticket.id,
          activeOnly: true,
        }),
      );
      assert.equal(claims.claims.length, 0);

      await call("objective_archive_project", {
        projectId: project.project.id,
        archiveTickets: true,
        reason: "phase21 cleanup",
      });
    });
  } finally {
    config.apiBase = previousApiBase;
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(async () => {
  await closePool();
});
