import { ObjectiveClient } from "../../packages/sdk/client.js";
import { archiveProject, archiveTicket, cleanupTestRuns } from "../../packages/core/archive.js";
import { toolManifest } from "../../packages/core/manifest.js";
import { projectSummary, ticketSummary } from "../../packages/core/responses.js";
import { runSelfTest } from "../../packages/core/self-test.js";
import {
  agentBootstrap,
  claimTicketAndFiles,
  keepalive,
  recordTestAndAttachLog,
  submitDoneWithArtifacts,
} from "../../packages/core/workflows.js";

function schema(properties = {}, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

const string = { type: "string" };
const bool = { type: "boolean" };
const number = { type: "number" };
const stringArray = { type: "array", items: { type: "string" } };

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

const paginationFields = {
  limit: number,
  cursor: string,
  q: string,
  createdAfter: string,
  includeArchived: bool,
  responseMode: { type: "string", enum: ["summary", "full"] },
};

function appendCommonParams(params, args) {
  if (args.limit !== undefined) params.set("limit", String(args.limit));
  if (args.cursor) params.set("cursor", args.cursor);
  if (args.q) params.set("q", args.q);
  if (args.createdAfter) params.set("createdAfter", args.createdAfter);
  if (args.includeArchived === true) params.set("includeArchived", "true");
}

function shapeProjects(payload, mode = "summary") {
  return {
    ...payload,
    projects: mode === "full" ? payload.projects : payload.projects.map(projectSummary),
  };
}

function shapeTickets(payload, mode = "summary") {
  return {
    ...payload,
    tickets: mode === "full" ? payload.tickets : payload.tickets.map(ticketSummary),
  };
}

export function createTools(client = new ObjectiveClient()) {
  const tools = [
    tool(
      "objective_health",
      "Check whether Objective API and MCP are reachable.",
      schema(),
      async () => client.get("/api/health"),
    ),
    tool("objective_create_agent", "Register an Objective agent identity.", schema({
      name: string,
      kind: { type: "string", enum: ["codex", "claude", "human", "system", "unknown"] },
    }, ["name"]), async (args) => client.post("/api/agents", args)),
    tool("objective_list_projects", "List Objective projects. Defaults to the 25 most recently updated projects to keep agent context compact.", schema({
      ...paginationFields,
    }), async (args) => {
      const params = new URLSearchParams();
      params.set("limit", String(args.limit ?? 25));
      appendCommonParams(params, args);
      const payload = await client.get(`/api/projects?${params}`);
      return shapeProjects(payload, args.responseMode ?? "summary");
    }),
    tool("objective_create_project", "Create an Objective project.", schema({
      name: string,
      description: string,
    }, ["name"]), async (args) => client.post("/api/projects", args)),
    tool("objective_get_project", "Read one Objective project.", schema({ projectId: string }, ["projectId"]), async (args) =>
      client.get(`/api/projects/${args.projectId}`),
    ),
    tool(
      "objective_list_project_tickets",
      "List tickets under a project.",
      schema({ projectId: string, ...paginationFields }, ["projectId"]),
      async (args) => {
        const params = new URLSearchParams();
        appendCommonParams(params, args);
        const payload = await client.get(`/api/projects/${args.projectId}/tickets?${params}`);
        return shapeTickets(payload, args.responseMode ?? "summary");
      },
    ),
    tool(
      "objective_get_available_tickets",
      "List claimable tickets in a project.",
      schema({ projectId: string, ...paginationFields }, ["projectId"]),
      async (args) => {
        const params = new URLSearchParams();
        appendCommonParams(params, args);
        const payload = await client.get(`/api/projects/${args.projectId}/available-tickets?${params}`);
        return shapeTickets(payload, args.responseMode ?? "summary");
      },
    ),
    tool("objective_search_tickets", "Search tickets by text, project, or status.", schema({
      projectId: string,
      q: string,
      status: string,
      limit: number,
      cursor: string,
      createdAfter: string,
      includeArchived: bool,
      responseMode: { type: "string", enum: ["summary", "full"] },
    }), async (args) => {
      const params = new URLSearchParams();
      if (args.projectId) params.set("projectId", args.projectId);
      if (args.q) params.set("q", args.q);
      if (args.status) params.set("status", args.status);
      appendCommonParams(params, args);
      const payload = await client.get(`/api/tickets/search?${params}`);
      return shapeTickets(payload, args.responseMode ?? "summary");
    }),
    tool(
      "objective_create_ticket",
      "Create an Objective ticket.",
      schema(
        {
          projectId: string,
          actorAgentId: string,
          title: string,
          why: string,
          description: string,
          plannedFiles: stringArray,
          testPlan: string,
          computerUseRequired: bool,
          idempotencyKey: string,
        },
        ["projectId", "title", "why", "description"],
      ),
      async (args) => client.post("/api/tickets", args),
    ),
    tool("objective_get_ticket", "Read a ticket and proof artifacts.", schema({ ticketId: string }, ["ticketId"]), async (args) =>
      client.get(`/api/tickets/${args.ticketId}`),
    ),
    tool("objective_claim_ticket", "Claim a ticket and receive a lease token.", schema({
      ticketId: string,
      agentId: string,
      idempotencyKey: string,
    }, ["ticketId", "agentId"]), async ({ ticketId, ...args }) => client.post(`/api/tickets/${ticketId}/claim`, args)),
    tool("objective_claim_ticket_and_files", "Claim a ticket and its files in one safe operation; releases the ticket if file claims fail by default.", schema({
      ticketId: string,
      agentId: string,
      files: stringArray,
      idempotencyKey: string,
      keepTicketClaimOnFileConflict: bool,
      responseMode: { type: "string", enum: ["summary", "full"] },
    }, ["ticketId", "agentId", "files"]), async (args) => claimTicketAndFiles(args)),
    tool("objective_renew_ticket_lease", "Renew an active ticket lease.", schema({
      ticketId: string,
      agentId: string,
      leaseToken: string,
    }, ["ticketId", "agentId", "leaseToken"]), async ({ ticketId, ...args }) => client.post(`/api/tickets/${ticketId}/lease`, args)),
    tool("objective_release_ticket", "Release a claimed ticket.", schema({
      ticketId: string,
      agentId: string,
      leaseToken: string,
    }, ["ticketId", "agentId", "leaseToken"]), async ({ ticketId, ...args }) => client.post(`/api/tickets/${ticketId}/release`, args)),
    tool("objective_update_ticket", "Update a claimed ticket.", schema({
      ticketId: string,
      agentId: string,
      leaseToken: string,
      patch: { type: "object", additionalProperties: true },
      idempotencyKey: string,
    }, ["ticketId", "agentId", "leaseToken", "patch"]), async ({ ticketId, ...args }) => client.patch(`/api/tickets/${ticketId}`, args)),
    tool("objective_claim_files", "Claim files or path patterns for a ticket.", schema({
      ticketId: string,
      agentId: string,
      leaseToken: string,
      files: stringArray,
      idempotencyKey: string,
    }, ["ticketId", "agentId", "leaseToken", "files"]), async ({ ticketId, ...args }) => client.post(`/api/tickets/${ticketId}/files/claim`, args)),
    tool("objective_release_files", "Release file claims for a ticket.", schema({
      ticketId: string,
      agentId: string,
      leaseToken: string,
      files: stringArray,
    }, ["ticketId", "agentId", "leaseToken"]), async ({ ticketId, ...args }) => client.post(`/api/tickets/${ticketId}/files/release`, args)),
    tool("objective_get_file_claims", "List active file claims.", schema({
      projectId: string,
      ticketId: string,
      agentId: string,
      activeOnly: bool,
      limit: number,
      cursor: string,
      includeArchived: bool,
    }), async (args) => {
      const params = new URLSearchParams();
      if (args.projectId) params.set("projectId", args.projectId);
      if (args.ticketId) params.set("ticketId", args.ticketId);
      if (args.agentId) params.set("agentId", args.agentId);
      if (args.activeOnly === false) params.set("activeOnly", "false");
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      if (args.cursor) params.set("cursor", args.cursor);
      if (args.includeArchived === true) params.set("includeArchived", "true");
      return client.get(`/api/file-claims?${params}`);
    }),
    tool("objective_record_test", "Record a test run for a claimed ticket.", schema({
      ticketId: string,
      agentId: string,
      leaseToken: string,
      command: string,
      status: string,
      output: string,
      idempotencyKey: string,
    }, ["ticketId", "agentId", "leaseToken", "command", "status"]), async ({ ticketId, ...args }) => client.post(`/api/tickets/${ticketId}/tests`, args)),
    tool("objective_record_test_and_attach_log", "Record a test run and attach its log artifact in one operation.", schema({
      ticketId: string,
      agentId: string,
      leaseToken: string,
      command: string,
      status: string,
      output: string,
      filename: string,
      idempotencyKey: string,
      responseMode: { type: "string", enum: ["summary", "full"] },
    }, ["ticketId", "agentId", "leaseToken", "command", "status"]), async (args) => recordTestAndAttachLog(args)),
    tool("objective_attach_artifact", "Attach proof artifact content to a ticket.", schema({
      ticketId: string,
      agentId: string,
      leaseToken: string,
      type: { type: "string" },
      filename: string,
      mimeType: string,
      content: string,
      contentBase64: string,
      label: string,
      idempotencyKey: string,
    }, ["ticketId", "agentId", "leaseToken", "type", "filename"]), async ({ ticketId, ...args }) => client.post(`/api/tickets/${ticketId}/artifact`, args)),
    tool("objective_attach_screenshot", "Attach a screenshot proof artifact to a ticket.", schema({
      ticketId: string,
      agentId: string,
      leaseToken: string,
      filename: string,
      mimeType: string,
      content: string,
      contentBase64: string,
      label: string,
      idempotencyKey: string,
    }, ["ticketId", "agentId", "leaseToken", "filename"]), async ({ ticketId, ...args }) =>
      client.post(`/api/tickets/${ticketId}/artifact`, { ...args, type: "screenshot" })),
    tool("objective_attach_proof", "Attach a generic proof artifact to a ticket.", schema({
      ticketId: string,
      agentId: string,
      leaseToken: string,
      filename: string,
      mimeType: string,
      content: string,
      contentBase64: string,
      label: string,
      idempotencyKey: string,
    }, ["ticketId", "agentId", "leaseToken", "filename"]), async ({ ticketId, ...args }) =>
      client.post(`/api/tickets/${ticketId}/artifact`, { ...args, type: "text-proof" })),
    tool("objective_validate_ticket_completion", "Check whether a ticket satisfies Done requirements.", schema({
      ticketId: string,
    }, ["ticketId"]), async (args) => client.get(`/api/tickets/${args.ticketId}/completion`)),
    tool("objective_submit_done", "Submit a claimed ticket for Done after proof exists.", schema({
      ticketId: string,
      agentId: string,
      leaseToken: string,
      finalAgentSummary: string,
      proofUrl: string,
      actualFilesChanged: stringArray,
    }, ["ticketId", "agentId", "leaseToken"]), async ({ ticketId, ...args }) => client.post(`/api/tickets/${ticketId}/done`, args)),
    tool("objective_submit_done_with_artifacts", "Attach optional final proof, default proofUrl to latest artifact URL, validate, and submit Done.", schema({
      ticketId: string,
      agentId: string,
      leaseToken: string,
      finalAgentSummary: string,
      proofUrl: string,
      actualFilesChanged: stringArray,
      proof: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: string,
          filename: string,
          mimeType: string,
          content: string,
          idempotencyKey: string,
        },
      },
      responseMode: { type: "string", enum: ["summary", "full"] },
    }, ["ticketId", "agentId", "leaseToken"]), async (args) => submitDoneWithArtifacts(args)),
    tool("objective_mark_blocked", "Mark a claimed ticket blocked with a reason.", schema({
      ticketId: string,
      agentId: string,
      leaseToken: string,
      reason: string,
    }, ["ticketId", "agentId", "leaseToken", "reason"]), async ({ ticketId, ...args }) => client.post(`/api/tickets/${ticketId}/blocked`, args)),
    tool("objective_reject_proof", "Reject submitted proof and move ticket to Verification Failed.", schema({
      ticketId: string,
      actorAgentId: string,
      reason: string,
    }, ["ticketId", "reason"]), async ({ ticketId, ...args }) => client.post(`/api/tickets/${ticketId}/reject-proof`, args)),
    tool("objective_reopen_ticket", "Reopen a ticket for more work.", schema({
      ticketId: string,
      actorAgentId: string,
      reason: string,
    }, ["ticketId"]), async ({ ticketId, ...args }) => client.post(`/api/tickets/${ticketId}/reopen`, args)),
    tool("objective_archive_project", "Archive a project and optionally its tickets so test data stays out of default lists.", schema({
      projectId: string,
      reason: string,
      archiveTickets: bool,
    }, ["projectId"]), async (args) => archiveProject(args)),
    tool("objective_archive_ticket", "Archive one ticket so it stays out of default lists.", schema({
      ticketId: string,
      reason: string,
    }, ["ticketId"]), async (args) => archiveTicket(args)),
    tool("objective_cleanup_test_runs", "Archive expired Objective test projects and tickets.", schema({
      olderThan: string,
      reason: string,
    }), async (args) => cleanupTestRuns({
      olderThan: args.olderThan ? new Date(args.olderThan) : new Date(),
      reason: args.reason,
    })),
    tool("objective_self_test", "Run a disposable Objective workflow test and return a pass/fail matrix.", schema({
      archive: bool,
      retentionMinutes: number,
    }), async (args) => runSelfTest(args)),
    tool("objective_get_blockers", "Read unfinished dependencies for a ticket.", schema({
      ticketId: string,
    }, ["ticketId"]), async (args) => client.get(`/api/tickets/${args.ticketId}/blockers`)),
    tool("objective_add_dependency", "Add a ticket dependency.", schema({
      ticketId: string,
      dependsOnTicketId: string,
    }, ["ticketId", "dependsOnTicketId"]), async ({ ticketId, ...args }) => client.post(`/api/tickets/${ticketId}/dependencies`, args)),
    tool("objective_heartbeat", "Record an agent heartbeat.", schema({
      agentId: string,
      ticketId: string,
      sessionId: string,
      metadata: { type: "object", additionalProperties: true },
    }, ["agentId"]), async (args) => client.post("/api/heartbeat", args)),
    tool("objective_keepalive", "Record heartbeat and optionally renew a ticket lease for long-running work.", schema({
      agentId: string,
      ticketId: string,
      leaseToken: string,
      sessionId: string,
      metadata: { type: "object", additionalProperties: true },
    }, ["agentId"]), async (args) => keepalive(args)),
    tool("objective_list_agent_work", "List active tickets assigned to an agent.", schema({
      agentId: string,
      limit: number,
      cursor: string,
      includeArchived: bool,
      responseMode: { type: "string", enum: ["summary", "full"] },
    }, ["agentId"]), async (args) => {
      const params = new URLSearchParams();
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      if (args.cursor) params.set("cursor", args.cursor);
      if (args.includeArchived === true) params.set("includeArchived", "true");
      const payload = await client.get(`/api/agents/${args.agentId}/work?${params}`);
      return shapeTickets(payload, args.responseMode ?? "summary");
    }),
    tool("objective_get_ticket_events", "Read append-only ticket event history.", schema({
      ticketId: string,
      limit: number,
      cursor: string,
      includeData: bool,
    }, ["ticketId"]), async (args) => {
      const params = new URLSearchParams();
      params.set("limit", String(args.limit ?? 25));
      if (args.cursor) params.set("cursor", args.cursor);
      params.set("includeData", args.includeData ? "true" : "false");
      const suffix = params.size ? `?${params}` : "";
      return client.get(`/api/tickets/${args.ticketId}/events${suffix}`);
    }),
  ];

  tools.unshift(
    tool("objective_tool_manifest", "Read Objective tool, schema, API, MCP, and plugin path metadata.", schema({
      pluginKind: { type: "string", enum: ["codex", "claude"] },
    }), async (args) => toolManifest({ tools, pluginKind: args.pluginKind ?? "codex" })),
    tool("objective_agent_bootstrap", "Register or reuse an agent and return health, manifest, current project, available tickets, active work, and active leases.", schema({
      agentName: string,
      name: string,
      kind: { type: "string", enum: ["codex", "claude", "human", "system", "unknown"] },
      agentId: string,
      externalKey: string,
      projectId: string,
      projectQuery: string,
      limit: number,
      pluginKind: { type: "string", enum: ["codex", "claude"] },
    }), async (args) => {
      const [health, bootstrap] = await Promise.all([
        client.get("/api/health").catch((err) => ({
          ok: false,
          error: err.code ?? "objective_health_failed",
          message: err.message,
        })),
        agentBootstrap({ ...args, tools, pluginKind: args.pluginKind ?? args.kind }),
      ]);
      return { ok: health.ok !== false, health, ...bootstrap };
    }),
  );

  return tools;
}

export function publicToolDefinitions(tools) {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}
