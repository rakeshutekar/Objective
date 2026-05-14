import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { createServer } from "../apps/web/server.js";
import { toolManifest } from "../packages/core/manifest.js";
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
    for (let attempt = 0; attempt < 150; attempt += 1) {
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

test("manifest and bootstrap expose plugin status and stable agent identity", async () => {
  await migrate();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const externalKey = `phase16-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const apiManifest = await fetch(`${apiBase}/api/tool-manifest?pluginKind=claude`).then((response) => response.json());
    assert.equal(apiManifest.plugin.pluginKind, "claude");
    assert.equal(apiManifest.plugin.manifestExists, true);
    assert.equal(apiManifest.plugin.skillExists, true);

    const directManifest = toolManifest({ pluginKind: "codex" });
    assert.equal(directManifest.plugin.manifestExists, true);
    assert.ok(directManifest.plugin.manifestPath.endsWith(".codex-plugin/plugin.json"));

    await withMcp({ OBJECTIVE_API_BASE: apiBase }, async (call) => {
      const manifest = parseToolText(await call("objective_tool_manifest", { pluginKind: "codex" }));
      assert.equal(manifest.schemaVersion, "002_agent_ergonomics");
      assert.ok(manifest.tools.some((tool) => tool.name === "objective_agent_bootstrap"));
      assert.equal(manifest.plugin.skillExists, true);

      const first = parseToolText(
        await call("objective_agent_bootstrap", {
          agentName: "Phase 16 Bootstrap Agent",
          kind: "codex",
          externalKey,
          limit: 3,
        }),
      );
      const second = parseToolText(
        await call("objective_agent_bootstrap", {
          agentName: "Phase 16 Bootstrap Agent",
          kind: "codex",
          externalKey,
          limit: 3,
        }),
      );
      assert.equal(first.health.ok, true);
      assert.equal(first.agent.id, second.agent.id);
      assert.ok(Array.isArray(first.availableTickets));
      assert.ok(Array.isArray(first.activeWork));
      assert.equal(first.manifest.tools, undefined);
      assert.equal(first.manifest.toolsOmitted, true);
      assert.ok(first.manifest.toolCount > 0);
      assert.equal(first.manifest.toolManifestTool, "objective_tool_manifest");
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(async () => {
  await closePool();
});
