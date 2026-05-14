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

test("archive tools release active leases and file claims", async () => {
  await migrate();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const unique = `phase20-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    await withMcp({ OBJECTIVE_API_BASE: apiBase }, async (call) => {
      const agent = parseToolText(await call("objective_create_agent", { name: "Phase 20 Archive Agent", kind: "codex" }));
      const project = parseToolText(await call("objective_create_project", { name: `Phase 20 Archive ${unique}` }));
      const projectTicket = parseToolText(
        await call("objective_create_ticket", {
          projectId: project.project.id,
          actorAgentId: agent.agent.id,
          title: "Archive project claimed ticket",
          why: "Archive should clean active coordination state",
          description: "Claimed ticket should not leave active file claims after project archive.",
          plannedFiles: [`${unique}/project.ts`],
        }),
      );
      await call("objective_claim_ticket_and_files", {
        ticketId: projectTicket.ticket.id,
        agentId: agent.agent.id,
        files: [`${unique}/project.ts`],
      });

      const archivedProject = parseToolText(
        await call("objective_archive_project", {
          projectId: project.project.id,
          archiveTickets: true,
          reason: "phase20 archive cleanup",
        }),
      );
      assert.equal(archivedProject.archivedTickets, true);
      assert.equal(archivedProject.releasedClaims, 1);
      assert.equal(archivedProject.releasedTickets, 1);

      const projectClaims = parseToolText(
        await call("objective_get_file_claims", {
          ticketId: projectTicket.ticket.id,
          activeOnly: true,
          includeArchived: true,
        }),
      );
      assert.equal(projectClaims.claims.length, 0);
      const projectRead = parseToolText(await call("objective_get_ticket", { ticketId: projectTicket.ticket.id }));
      assert.equal(projectRead.ticket.assignedAgentId, null);
      assert.equal(projectRead.ticket.leaseToken, null);
      assert.equal(projectRead.ticket.status, "Ready");

      const ticketProject = parseToolText(await call("objective_create_project", { name: `Phase 20 Ticket ${unique}` }));
      const singleTicket = parseToolText(
        await call("objective_create_ticket", {
          projectId: ticketProject.project.id,
          actorAgentId: agent.agent.id,
          title: "Archive ticket claimed ticket",
          why: "Ticket archive should also clean active coordination state",
          description: "Claimed ticket should not leave active file claims after ticket archive.",
          plannedFiles: [`${unique}/ticket.ts`],
        }),
      );
      await call("objective_claim_ticket_and_files", {
        ticketId: singleTicket.ticket.id,
        agentId: agent.agent.id,
        files: [`${unique}/ticket.ts`],
      });
      const archivedTicket = parseToolText(
        await call("objective_archive_ticket", {
          ticketId: singleTicket.ticket.id,
          reason: "phase20 ticket archive cleanup",
        }),
      );
      assert.equal(archivedTicket.releasedClaims, 1);
      assert.equal(archivedTicket.releasedTickets, 1);
      assert.equal(archivedTicket.ticket.status, "Ready");
      assert.equal(archivedTicket.ticket.assigned_agent_id, null);
      assert.equal(archivedTicket.ticket.lease_token, null);
      assert.equal(archivedTicket.ticket.lease_expires_at, null);

      const ticketClaims = parseToolText(
        await call("objective_get_file_claims", {
          ticketId: singleTicket.ticket.id,
          activeOnly: true,
          includeArchived: true,
        }),
      );
      assert.equal(ticketClaims.claims.length, 0);
      const work = parseToolText(
        await call("objective_list_agent_work", {
          agentId: agent.agent.id,
          includeArchived: true,
        }),
      );
      assert.equal(work.tickets.length, 0);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(async () => {
  await closePool();
});
