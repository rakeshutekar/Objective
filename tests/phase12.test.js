import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { access, readFile } from "node:fs/promises";
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
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = responses.find((response) => response.id === requestId);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for MCP tool ${name}`);
  }

  async function rpc(method, params = {}) {
    const requestId = id++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = responses.find((response) => response.id === requestId);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${method}`);
  }

  try {
    return await fn({ call, rpc });
  } finally {
    child.kill();
  }
}

test("Objective completes a full MCP-driven ticket workflow to Done", async () => {
  await migrate();
  const filePath = `phase12-${Date.now()}-${Math.random().toString(36).slice(2)}/README.md`;
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const apiBase = `http://127.0.0.1:${server.address().port}`;

  try {
    await withMcp({ OBJECTIVE_API_BASE: apiBase }, async ({ call, rpc }) => {
      const init = await rpc("initialize");
      assert.equal(init.result.serverInfo.name, "objective");

      const agent = parseToolText(
        await call("objective_create_agent", { name: "Phase 12 Codex E2E", kind: "codex" }),
      );
      const project = parseToolText(
        await call("objective_create_project", { name: "Phase 12 E2E", description: "Full workflow" }),
      );
      const ticket = parseToolText(
        await call("objective_create_ticket", {
          projectId: project.project.id,
          actorAgentId: agent.agent.id,
          title: "Complete through MCP",
          why: "Verify Objective is real end-to-end",
          description: "Claim, lock, test, attach proof, and finish.",
          plannedFiles: [filePath],
          testPlan: "Run npm test",
          computerUseRequired: true,
        }),
      );
      const claim = parseToolText(
        await call("objective_claim_ticket", {
          ticketId: ticket.ticket.id,
          agentId: agent.agent.id,
        }),
      );

      parseToolText(
        await call("objective_claim_files", {
          ticketId: ticket.ticket.id,
          agentId: agent.agent.id,
          leaseToken: claim.leaseToken,
          files: [filePath],
        }),
      );
      parseToolText(
        await call("objective_update_ticket", {
          ticketId: ticket.ticket.id,
          agentId: agent.agent.id,
          leaseToken: claim.leaseToken,
          patch: {
            actualFilesChanged: [filePath],
            proofUrl: apiBase,
            finalAgentSummary: "E2E test completed through Objective MCP.",
          },
        }),
      );
      parseToolText(
        await call("objective_record_test", {
          ticketId: ticket.ticket.id,
          agentId: agent.agent.id,
          leaseToken: claim.leaseToken,
          command: "npm test",
          status: "passed",
          output: "full suite scheduled",
        }),
      );
      parseToolText(
        await call("objective_attach_proof", {
          ticketId: ticket.ticket.id,
          agentId: agent.agent.id,
          leaseToken: claim.leaseToken,
          filename: "phase12-proof.txt",
          mimeType: "text/plain",
          content: "Objective E2E proof",
        }),
      );
      const completion = parseToolText(
        await call("objective_validate_ticket_completion", { ticketId: ticket.ticket.id }),
      );
      assert.equal(completion.ok, true);

      const done = parseToolText(
        await call("objective_submit_done", {
          ticketId: ticket.ticket.id,
          agentId: agent.agent.id,
          leaseToken: claim.leaseToken,
        }),
      );
      assert.equal(done.ticket.status, "Done");

      const activeClaims = parseToolText(
        await call("objective_get_file_claims", { projectId: project.project.id }),
      );
      assert.equal(activeClaims.claims.length, 0);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local marketplace metadata exists for both Codex and Claude", async () => {
  const codex = JSON.parse(await readFile(".agents/plugins/marketplace.json", "utf8"));
  const claude = JSON.parse(await readFile(".claude-plugin/marketplace.json", "utf8"));
  assert.equal(codex.plugins[0].name, "objective");
  assert.equal(claude.plugins[0].name, "objective");

  const codexManifest = JSON.parse(await readFile("plugins/codex/.codex-plugin/plugin.json", "utf8"));
  assert.equal(codexManifest.skills, "./skills/");
  await access("plugins/codex/skills/objective/SKILL.md");
  await access("plugins/claude/skills/objective/SKILL.md");
});

test.after(async () => {
  await closePool();
});
