import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createServer } from "../apps/web/server.js";
import { closePool } from "../packages/db/client.js";
import { migrate } from "../packages/db/migrate.js";

function parseToolText(response) {
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

async function timed(call, name, args) {
  const startedAt = performance.now();
  const response = await call(name, args);
  return {
    response,
    ms: performance.now() - startedAt,
  };
}

test("latency-sensitive MCP tools stay fast and compact", async () => {
  await migrate();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const filePath = `phase13-${Date.now()}-${Math.random().toString(36).slice(2)}/tool.ts`;

  try {
    await withMcp({ OBJECTIVE_API_BASE: apiBase }, async (call) => {
      const health = await timed(call, "objective_health", {});
      assert.equal(parseToolText(health.response).ok, true);

      const agent = parseToolText(
        await call("objective_create_agent", { name: "Phase 13 Perf Agent", kind: "codex" }),
      );
      const project = parseToolText(
        await call("objective_create_project", { name: "Phase 13 Perf", description: "Latency guard" }),
      );
      const ticket = parseToolText(
        await call("objective_create_ticket", {
          projectId: project.project.id,
          actorAgentId: agent.agent.id,
          title: "Latency ticket",
          why: "Protect agent tool responsiveness",
          description: "Measure tools that must stay responsive.",
          plannedFiles: [filePath],
        }),
      );
      const claim = parseToolText(
        await call("objective_claim_ticket", { ticketId: ticket.ticket.id, agentId: agent.agent.id }),
      );

      const renew = await timed(call, "objective_renew_ticket_lease", {
        ticketId: ticket.ticket.id,
        agentId: agent.agent.id,
        leaseToken: claim.leaseToken,
      });
      const update = await timed(call, "objective_update_ticket", {
        ticketId: ticket.ticket.id,
        agentId: agent.agent.id,
        leaseToken: claim.leaseToken,
        patch: { actualFilesChanged: [filePath] },
      });
      const events = await timed(call, "objective_get_ticket_events", {
        ticketId: ticket.ticket.id,
        limit: 5,
      });

      for (const [name, result] of Object.entries({ health, renew, update, events })) {
        assert.ok(result.ms < 1500, `${name} took ${result.ms.toFixed(1)}ms`);
        assert.equal(result.response.result.content[0].text.includes("\n"), false);
      }
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(async () => {
  await closePool();
});
