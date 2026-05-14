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

test("self-test runs a disposable workflow and archives created data", async () => {
  await migrate();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const apiBase = `http://127.0.0.1:${server.address().port}`;

  try {
    await withMcp({ OBJECTIVE_API_BASE: apiBase }, async (call) => {
      const selfTest = parseToolText(await call("objective_self_test", { archive: true, retentionMinutes: 1 }));
      assert.equal(selfTest.ok, true);
      assert.ok(selfTest.steps.every((step) => step.status === "passed"));
      assert.ok(selfTest.created.projectId);
      assert.ok(selfTest.created.ticketId);

      const projects = parseToolText(
        await call("objective_list_projects", {
          q: "Objective Self Test",
          includeArchived: true,
          responseMode: "full",
        }),
      );
      const archived = projects.projects.find((project) => project.id === selfTest.created.projectId);
      assert.ok(archived.archivedAt);

      const cleanup = parseToolText(await call("objective_cleanup_test_runs", {}));
      assert.ok(Array.isArray(cleanup.archivedProjects));
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(async () => {
  await closePool();
});
