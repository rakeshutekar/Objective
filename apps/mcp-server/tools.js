import { ObjectiveClient } from "../../packages/sdk/client.js";

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

function compactProject(project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
  };
}

export function createTools(client = new ObjectiveClient()) {
  return [
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
      limit: number,
      q: string,
    }), async (args) => {
      const params = new URLSearchParams();
      params.set("limit", String(args.limit ?? 25));
      if (args.q) params.set("q", args.q);
      const payload = await client.get(`/api/projects?${params}`);
      return {
        projects: payload.projects.map(compactProject),
        count: payload.count,
        total: payload.total,
        hasMore: payload.hasMore,
      };
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
      schema({ projectId: string }, ["projectId"]),
      async (args) => client.get(`/api/projects/${args.projectId}/tickets`),
    ),
    tool(
      "objective_get_available_tickets",
      "List claimable tickets in a project.",
      schema({ projectId: string }, ["projectId"]),
      async (args) => client.get(`/api/projects/${args.projectId}/available-tickets`),
    ),
    tool("objective_search_tickets", "Search tickets by text, project, or status.", schema({
      projectId: string,
      q: string,
      status: string,
    }), async (args) => {
      const params = new URLSearchParams();
      if (args.projectId) params.set("projectId", args.projectId);
      if (args.q) params.set("q", args.q);
      if (args.status) params.set("status", args.status);
      return client.get(`/api/tickets/search?${params}`);
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
      activeOnly: bool,
    }), async (args) => {
      const params = new URLSearchParams();
      if (args.projectId) params.set("projectId", args.projectId);
      if (args.ticketId) params.set("ticketId", args.ticketId);
      if (args.activeOnly === false) params.set("activeOnly", "false");
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
    tool("objective_list_agent_work", "List active tickets assigned to an agent.", schema({
      agentId: string,
    }, ["agentId"]), async (args) => client.get(`/api/agents/${args.agentId}/work`)),
    tool("objective_get_ticket_events", "Read append-only ticket event history.", schema({
      ticketId: string,
      limit: number,
      includeData: bool,
    }, ["ticketId"]), async (args) => {
      const params = new URLSearchParams();
      params.set("limit", String(args.limit ?? 25));
      params.set("includeData", args.includeData ? "true" : "false");
      const suffix = params.size ? `?${params}` : "";
      return client.get(`/api/tickets/${args.ticketId}/events${suffix}`);
    }),
  ];
}

export function publicToolDefinitions(tools) {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}
