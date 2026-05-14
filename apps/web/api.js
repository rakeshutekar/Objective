import crypto from "node:crypto";
import { ObjectiveError } from "../../packages/core/errors.js";
import { config } from "../../packages/core/config.js";
import { toolManifest } from "../../packages/core/manifest.js";
import { runSelfTest } from "../../packages/core/self-test.js";
import { withTimeout } from "../../packages/core/timeout.js";
import { assertEnum, assertUuid, boolParam, normalizeDatabaseError, optionalUuid } from "../../packages/core/validation.js";
import {
  addTicketDependency,
  attachArtifact,
  claimFiles,
  claimTicket,
  countProjects,
  createAgent,
  createProject,
  createTicket,
  getArtifactById,
  getArtifactUrl,
  getAvailableTickets,
  getBlockers,
  getFileClaims,
  getProject,
  getTicket,
  getTicketEvents,
  heartbeat,
  listProjectTickets,
  listProjects,
  listProofArtifacts,
  listAgentWork,
  markBlocked,
  recordTest,
  rejectProof,
  reopenTicket,
  releaseFiles,
  releaseTicket,
  renewTicketLease,
  searchTickets,
  submitDone,
  updateTicket,
  validateTicketCompletion,
} from "../../packages/core/lifecycle.js";
import { query } from "../../packages/db/client.js";
import { ensureBucket } from "../../packages/storage/minio.js";

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function bodyJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function bearer(req) {
  const header = req.headers.authorization ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
}

async function requireAuth(req) {
  const token = bearer(req);
  if (token === config.agentApiKey || token === config.adminToken) return true;
  throw new ObjectiveError("unauthorized", "Missing or invalid Objective API token.", 401);
}

async function dbHealth() {
  await query("SELECT 1");
  return true;
}

async function timedHealth(label, check) {
  const startedAt = Date.now();
  try {
    await withTimeout(
      check(),
      config.healthCheckTimeoutMs,
      `${label} health check timed out after ${config.healthCheckTimeoutMs}ms.`,
    );
    return { status: "ok", latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Date.now() - startedAt,
      message: err.message,
    };
  }
}

async function realtimeSnapshot() {
  const ticketCounts = await query(
    `
      SELECT status, count(*)::int AS count
      FROM tickets
      GROUP BY status
    `,
  );
  const activeClaims = await query(
    `
      SELECT count(*)::int AS count
      FROM ticket_file_claims
      WHERE released_at IS NULL AND expires_at > now()
    `,
  );
  const activeAgents = await query(
    `
      SELECT count(DISTINCT agent_id)::int AS count
      FROM agent_heartbeats
      WHERE seen_at > now() - interval '2 minutes'
    `,
  );
  const latestEvents = await query(
    `
      SELECT ticket_id, event_type, message, created_at
      FROM ticket_events
      ORDER BY created_at DESC
      LIMIT 10
    `,
  );

  return {
    ticketCounts: Object.fromEntries(ticketCounts.rows.map((row) => [row.status, row.count])),
    activeFileClaims: activeClaims.rows[0].count,
    activeAgents: activeAgents.rows[0].count,
    latestEvents: latestEvents.rows,
    emittedAt: new Date().toISOString(),
  };
}

async function streamEvents(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.flushHeaders?.();

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  async function send() {
    if (closed) return;
    try {
      res.write(`event: objective\n`);
      res.write(`data: ${JSON.stringify(await realtimeSnapshot())}\n\n`);
    } catch (err) {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ message: err.message })}\n\n`);
    }
  }

  await send();
  const interval = setInterval(send, 2000);
  req.on("close", () => clearInterval(interval));
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;
  const path = url.pathname;

  if (method === "GET" && path === "/api/health") {
    const [database, storage] = await Promise.all([
      timedHealth("database", dbHealth),
      timedHealth("storage", ensureBucket),
    ]);
    sendJson(res, 200, {
      ok: database.status === "ok" && storage.status === "ok",
      service: "objective-web",
      database: database.status,
      storage: storage.status,
      checks: { database, storage },
    });
    return true;
  }

  if (method === "GET" && path === "/api/events") {
    await streamEvents(req, res);
    return true;
  }

  if (method === "GET" && path === "/api/tool-manifest") {
    const pluginKind = assertEnum(
      url.searchParams.get("pluginKind") ?? "codex",
      "plugin_kind",
      ["codex", "claude"],
    );
    sendJson(res, 200, toolManifest({ tools: [], pluginKind }));
    return true;
  }

  if (method === "POST" && path === "/api/self-test") {
    await requireAuth(req);
    const input = await bodyJson(req);
    sendJson(res, 200, await runSelfTest(input));
    return true;
  }

  if (method === "GET" && path === "/api/projects") {
    const projectQuery = {
      q: url.searchParams.get("q") ?? "",
      limit: url.searchParams.get("limit"),
      cursor: url.searchParams.get("cursor"),
      createdAfter: url.searchParams.get("createdAfter"),
      includeArchived: boolParam(url.searchParams.get("includeArchived"), false),
      paginated: true,
    };
    const page = await listProjects(projectQuery);
    const total = await countProjects(projectQuery);
    sendJson(res, 200, {
      projects: page.items,
      count: page.count,
      total,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    });
    return true;
  }

  if (method === "POST" && path === "/api/projects") {
    await requireAuth(req);
    const input = await bodyJson(req);
    sendJson(res, 201, { project: await createProject(input) });
    return true;
  }

  const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
  if (method === "GET" && projectMatch) {
    const projectId = assertUuid(projectMatch[1], "projectId");
    sendJson(res, 200, { project: await getProject(projectId) });
    return true;
  }

  const projectTicketsMatch = path.match(/^\/api\/projects\/([^/]+)\/tickets$/);
  if (method === "GET" && projectTicketsMatch) {
    const projectId = assertUuid(projectTicketsMatch[1], "projectId");
    const page = await listProjectTickets(projectId, {
      limit: url.searchParams.get("limit"),
      cursor: url.searchParams.get("cursor"),
      q: url.searchParams.get("q") ?? "",
      createdAfter: url.searchParams.get("createdAfter"),
      includeArchived: boolParam(url.searchParams.get("includeArchived"), false),
      paginated: true,
    });
    sendJson(res, 200, { tickets: page.items, count: page.count, hasMore: page.hasMore, nextCursor: page.nextCursor });
    return true;
  }

  const availableTicketsMatch = path.match(/^\/api\/projects\/([^/]+)\/available-tickets$/);
  if (method === "GET" && availableTicketsMatch) {
    const projectId = assertUuid(availableTicketsMatch[1], "projectId");
    const page = await getAvailableTickets(projectId, {
      limit: url.searchParams.get("limit"),
      cursor: url.searchParams.get("cursor"),
      createdAfter: url.searchParams.get("createdAfter"),
      includeArchived: boolParam(url.searchParams.get("includeArchived"), false),
      paginated: true,
    });
    sendJson(res, 200, { tickets: page.items, count: page.count, hasMore: page.hasMore, nextCursor: page.nextCursor });
    return true;
  }

  if (method === "POST" && path === "/api/agents") {
    await requireAuth(req);
    const input = await bodyJson(req);
    sendJson(res, 201, { agent: await createAgent(input) });
    return true;
  }

  if (method === "POST" && path === "/api/tickets") {
    await requireAuth(req);
    const input = await bodyJson(req);
    assertUuid(input.projectId, "projectId");
    optionalUuid(input.actorAgentId, "agentId");
    sendJson(res, 201, await createTicket(input));
    return true;
  }

  if (method === "GET" && path === "/api/tickets/search") {
    const status = url.searchParams.get("status");
    sendJson(res, 200, {
      ...(await (async () => {
        const page = await searchTickets({
          projectId: optionalUuid(url.searchParams.get("projectId"), "projectId"),
          q: url.searchParams.get("q") ?? "",
          status: assertEnum(status, "status", [
            "Draft",
            "Ready",
            "Claimed",
            "In Progress",
            "Blocked",
            "Proof Submitted",
            "Verification Failed",
            "Done",
            "Canceled",
            "Reopened",
          ]),
          limit: url.searchParams.get("limit"),
          cursor: url.searchParams.get("cursor"),
          createdAfter: url.searchParams.get("createdAfter"),
          includeArchived: boolParam(url.searchParams.get("includeArchived"), false),
          paginated: true,
        });
        return { tickets: page.items, count: page.count, hasMore: page.hasMore, nextCursor: page.nextCursor };
      })()),
    });
    return true;
  }

  const ticketMatch = path.match(/^\/api\/tickets\/([^/]+)$/);
  if (method === "GET" && ticketMatch) {
    const ticketId = assertUuid(ticketMatch[1], "ticketId");
    const ticket = await getTicket(ticketId);
    const artifacts = await listProofArtifacts(ticket.id);
    sendJson(res, 200, { ticket, artifacts });
    return true;
  }

  if (method === "PATCH" && ticketMatch) {
    await requireAuth(req);
    const ticketId = assertUuid(ticketMatch[1], "ticketId");
    const input = await bodyJson(req);
    assertUuid(input.agentId, "agentId");
    sendJson(res, 200, await updateTicket({ ticketId, ...input }));
    return true;
  }

  const actionMatch = path.match(/^\/api\/tickets\/([^/]+)\/([^/]+)$/);
  if (actionMatch) {
    const ticketId = assertUuid(actionMatch[1], "ticketId");
    const action = actionMatch[2];

    if (method === "GET" && action === "events") {
      const page = await getTicketEvents(ticketId, {
        limit: url.searchParams.get("limit"),
        cursor: url.searchParams.get("cursor"),
        includeData: url.searchParams.get("includeData") !== "false",
        paginated: true,
      });
      sendJson(res, 200, {
        events: page.items,
        count: page.count,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      });
      return true;
    }

    if (method === "GET" && action === "completion") {
      sendJson(res, 200, await validateTicketCompletion(ticketId));
      return true;
    }

    if (method === "GET" && action === "blockers") {
      sendJson(res, 200, { blockers: await getBlockers(ticketId) });
      return true;
    }

    await requireAuth(req);
    const input = await bodyJson(req);
    if (["claim", "lease", "release", "tests", "artifact", "done", "blocked"].includes(action)) {
      assertUuid(input.agentId, "agentId");
    }
    if (["reject-proof", "reopen"].includes(action)) {
      optionalUuid(input.actorAgentId, "agentId");
    }

    if (method === "POST" && action === "claim") {
      sendJson(res, 200, await claimTicket({ ticketId, ...input }));
      return true;
    }

    if (method === "POST" && action === "lease") {
      sendJson(res, 200, await renewTicketLease({ ticketId, ...input }));
      return true;
    }

    if (method === "POST" && action === "release") {
      sendJson(res, 200, await releaseTicket({ ticketId, ...input }));
      return true;
    }

    if (method === "POST" && action === "tests") {
      sendJson(res, 201, await recordTest({ ticketId, ...input }));
      return true;
    }

    if (method === "POST" && action === "artifact") {
      const content = input.contentBase64
        ? Buffer.from(input.contentBase64, "base64")
        : (input.content ?? "");
      sendJson(res, 201, await attachArtifact({ ticketId, ...input, content }));
      return true;
    }

    if (method === "POST" && action === "done") {
      sendJson(res, 200, await submitDone({ ticketId, ...input }));
      return true;
    }

    if (method === "POST" && action === "blocked") {
      sendJson(res, 200, await markBlocked({ ticketId, ...input }));
      return true;
    }

    if (method === "POST" && action === "reject-proof") {
      sendJson(res, 200, await rejectProof({ ticketId, ...input }));
      return true;
    }

    if (method === "POST" && action === "reopen") {
      sendJson(res, 200, await reopenTicket({ ticketId, ...input }));
      return true;
    }

    if (method === "POST" && action === "dependencies") {
      assertUuid(input.dependsOnTicketId, "dependsOnTicketId");
      sendJson(res, 201, {
        dependency: await addTicketDependency({
          ticketId,
          dependsOnTicketId: input.dependsOnTicketId,
        }),
      });
      return true;
    }
  }

  const filesMatch = path.match(/^\/api\/tickets\/([^/]+)\/files\/(claim|release)$/);
  if (filesMatch) {
    await requireAuth(req);
    const ticketId = assertUuid(filesMatch[1], "ticketId");
    const input = await bodyJson(req);
    assertUuid(input.agentId, "agentId");
    if (method === "POST" && filesMatch[2] === "claim") {
      sendJson(res, 200, await claimFiles({ ticketId, ...input }));
      return true;
    }
    if (method === "POST" && filesMatch[2] === "release") {
      sendJson(res, 200, await releaseFiles({ ticketId, ...input }));
      return true;
    }
  }

  if (method === "GET" && path === "/api/file-claims") {
    const page = await getFileClaims({
      projectId: optionalUuid(url.searchParams.get("projectId"), "projectId"),
      ticketId: optionalUuid(url.searchParams.get("ticketId"), "ticketId"),
      activeOnly: url.searchParams.get("activeOnly") !== "false",
      limit: url.searchParams.get("limit"),
      cursor: url.searchParams.get("cursor"),
      includeArchived: boolParam(url.searchParams.get("includeArchived"), false),
      paginated: true,
    });
    sendJson(res, 200, {
      claims: page.items,
      count: page.count,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    });
    return true;
  }

  if (method === "POST" && path === "/api/heartbeat") {
    await requireAuth(req);
    const input = await bodyJson(req);
    sendJson(res, 201, { heartbeat: await heartbeat(input) });
    return true;
  }

  const agentWorkMatch = path.match(/^\/api\/agents\/([^/]+)\/work$/);
  if (method === "GET" && agentWorkMatch) {
    const agentId = assertUuid(agentWorkMatch[1], "agentId");
    const page = await listAgentWork(agentId, {
      limit: url.searchParams.get("limit"),
      cursor: url.searchParams.get("cursor"),
      includeArchived: boolParam(url.searchParams.get("includeArchived"), false),
      paginated: true,
    });
    sendJson(res, 200, { tickets: page.items, count: page.count, hasMore: page.hasMore, nextCursor: page.nextCursor });
    return true;
  }

  if (method === "GET" && path === "/api/artifact-url") {
    const objectKey = url.searchParams.get("objectKey");
    if (!objectKey) throw new ObjectiveError("object_key_required", "objectKey query parameter is required.");
    sendJson(res, 200, { url: await getArtifactUrl(objectKey) });
    return true;
  }

  const artifactMatch = path.match(/^\/api\/artifacts\/([^/]+)\/(url|download)$/);
  if (method === "GET" && artifactMatch) {
    const artifactId = assertUuid(artifactMatch[1], "artifactId");
    const artifact = await getArtifactById(artifactId);
    if (artifactMatch[2] === "url") {
      sendJson(res, 200, {
        artifact,
        downloadUrl: artifact.downloadUrl,
        presignedUrl: artifact.presignedUrl,
      });
      return true;
    }
    res.writeHead(302, { location: artifact.presignedUrl });
    res.end();
    return true;
  }

  return false;
}

export async function handleApi(req, res) {
  try {
    const handled = await route(req, res);
    return handled;
  } catch (err) {
    if (err instanceof SyntaxError) {
      sendJson(res, 400, { error: "invalid_json", message: err.message });
      return true;
    }
    const normalized = normalizeDatabaseError(err);
    if (normalized instanceof ObjectiveError) {
      sendJson(res, normalized.status, { error: normalized.code, message: normalized.message, details: normalized.details });
      return true;
    }
    const requestId = crypto.randomUUID();
    console.error(`[${requestId}]`, err);
    sendJson(res, 500, { error: "internal_error", message: "Objective API failed.", requestId });
    return true;
  }
}
