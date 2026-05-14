import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { createServer } from "../../apps/web/server.js";
import { closePool } from "../../packages/db/client.js";
import { migrate } from "../../packages/db/migrate.js";

function parseToolText(response) {
  assert.equal(response.result?.isError, undefined, response.result?.content?.[0]?.text);
  return JSON.parse(response.result.content[0].text);
}

async function withPluginWrapper(scriptPath, apiBase, fn) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OBJECTIVE_WORKSPACE_ROOT: process.cwd(),
      OBJECTIVE_API_BASE: apiBase,
      OBJECTIVE_AGENT_API_KEY: "dev-agent-key",
    },
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

async function completeTicketThroughWrapper({ call, apiBase, kind, label }) {
  const filePath = `e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}/component.tsx`;
  const agent = parseToolText(
    await call("objective_create_agent", { name: `${label} Plugin Agent`, kind }),
  );
  const project = parseToolText(
    await call("objective_create_project", { name: `${label} Plugin E2E`, description: "Plugin wrapper verification" }),
  );
  const ticket = parseToolText(
    await call("objective_create_ticket", {
      projectId: project.project.id,
      actorAgentId: agent.agent.id,
      title: `${label} wrapper ticket`,
      why: "Verify the installed plugin entrypoint can drive Objective",
      description: "Create, claim, lock files, record test evidence, attach proof, and mark Done.",
      plannedFiles: [filePath],
      testPlan: "node --test tests/e2e/plugin-wrappers.test.js",
      computerUseRequired: true,
    }),
  );
  const claim = parseToolText(
    await call("objective_claim_ticket", { ticketId: ticket.ticket.id, agentId: agent.agent.id }),
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
        finalAgentSummary: `${label} plugin wrapper completed the ticket.`,
      },
    }),
  );
  parseToolText(
    await call("objective_record_test", {
      ticketId: ticket.ticket.id,
      agentId: agent.agent.id,
      leaseToken: claim.leaseToken,
      command: "node --test tests/e2e/plugin-wrappers.test.js",
      status: "passed",
      output: `${label} wrapper completed Objective workflow`,
    }),
  );
  parseToolText(
    await call("objective_attach_screenshot", {
      ticketId: ticket.ticket.id,
      agentId: agent.agent.id,
      leaseToken: claim.leaseToken,
      filename: `${label.toLowerCase()}-proof.txt`,
      mimeType: "text/plain",
      content: `${label} Objective proof`,
    }),
  );

  const activeWork = parseToolText(await call("objective_list_agent_work", { agentId: agent.agent.id }));
  assert.ok(activeWork.tickets.some((active) => active.id === ticket.ticket.id));

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

  const claims = parseToolText(await call("objective_get_file_claims", { projectId: project.project.id }));
  assert.equal(claims.claims.length, 0);
}

test("Codex and Claude plugin wrappers complete Objective tickets", async () => {
  await migrate();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const apiBase = `http://127.0.0.1:${server.address().port}`;

  try {
    await withPluginWrapper("plugins/codex/server.js", apiBase, async (call) => {
      await completeTicketThroughWrapper({ call, apiBase, kind: "codex", label: "Codex" });
    });
    await withPluginWrapper("plugins/claude/server.js", apiBase, async (call) => {
      await completeTicketThroughWrapper({ call, apiBase, kind: "claude", label: "Claude" });
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(async () => {
  await closePool();
});
