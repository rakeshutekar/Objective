import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  async function call(method, params = {}) {
    const requestId = id++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = responses.find((response) => response.id === requestId);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for MCP response to ${method}`);
  }

  try {
    return await fn(call);
  } finally {
    child.kill();
  }
}

test("MCP tools can create, read, claim, and update Objective tickets", async () => {
  await migrate();
  const filePath = `phase7-${Date.now()}-${Math.random().toString(36).slice(2)}/server.js`;
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const apiBase = `http://127.0.0.1:${server.address().port}`;

  try {
    await withMcp({ OBJECTIVE_API_BASE: apiBase }, async (call) => {
      const init = await call("initialize");
      assert.equal(init.result.serverInfo.name, "objective");

      const listed = await call("tools/list");
      const names = listed.result.tools.map((tool) => tool.name);
      assert.ok(names.includes("objective_create_ticket"));
      assert.ok(names.includes("objective_get_ticket"));
      assert.ok(names.includes("objective_claim_files"));

      const agent = parseToolText(
        await call("tools/call", {
          name: "objective_create_agent",
          arguments: { name: "Phase 7 MCP Agent", kind: "claude" },
        }),
      );
      const project = parseToolText(
        await call("tools/call", {
          name: "objective_create_project",
          arguments: { name: "Phase 7 MCP", description: "MCP verification" },
        }),
      );
      const ticket = parseToolText(
        await call("tools/call", {
          name: "objective_create_ticket",
          arguments: {
            projectId: project.project.id,
            actorAgentId: agent.agent.id,
            title: "MCP ticket",
            why: "Verify MCP tools",
            description: "Create and claim through MCP",
            plannedFiles: [filePath],
          },
        }),
      );
      const claim = parseToolText(
        await call("tools/call", {
          name: "objective_claim_ticket",
          arguments: { ticketId: ticket.ticket.id, agentId: agent.agent.id },
        }),
      );
      assert.ok(claim.leaseToken);

      const files = parseToolText(
        await call("tools/call", {
          name: "objective_claim_files",
          arguments: {
            ticketId: ticket.ticket.id,
            agentId: agent.agent.id,
            leaseToken: claim.leaseToken,
            files: [filePath],
          },
        }),
      );
      assert.equal(files.claims.length, 1);

      const read = parseToolText(
        await call("tools/call", {
          name: "objective_get_ticket",
          arguments: { ticketId: ticket.ticket.id },
        }),
      );
      assert.equal(read.ticket.title, "MCP ticket");
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(async () => {
  await closePool();
});
