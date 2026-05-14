import crypto from "node:crypto";
import { config } from "./config.js";
import { assertCondition, ObjectiveError } from "./errors.js";
import { withIdempotency } from "./idempotency.js";
import { appendCursorFilter, cursorFromRow, pageLimit, pageResult } from "./pagination.js";
import { normalizePathPattern, patternsOverlap } from "./path-locks.js";
import { parseIsoDate } from "./validation.js";
import { query, withTransaction } from "../db/client.js";
import { putArtifactObject, presignedArtifactUrl } from "../storage/minio.js";

const mutableClaimedStatuses = new Set([
  "Claimed",
  "In Progress",
  "Blocked",
  "Proof Submitted",
  "Verification Failed",
]);

function leaseExpiry(ttlSeconds = config.leaseTtlSeconds) {
  return new Date(Date.now() + ttlSeconds * 1000);
}

function leaseRenewAt(expiresAt) {
  if (!expiresAt) return null;
  const expiry = new Date(expiresAt);
  const renewOffsetSeconds = Math.max(30, Math.floor(config.leaseTtlSeconds / 3));
  return new Date(expiry.getTime() - renewOffsetSeconds * 1000).toISOString();
}

function leasePayload(ticket, leaseToken = ticket?.leaseToken) {
  if (!ticket) return null;
  return {
    leaseToken,
    leaseExpiresAt: ticket.leaseExpiresAt,
    leaseTtlSeconds: config.leaseTtlSeconds,
    renewAt: leaseRenewAt(ticket.leaseExpiresAt),
  };
}

function token() {
  return crypto.randomBytes(24).toString("base64url");
}

function normalizeTicket(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    why: row.why,
    description: row.description,
    status: row.status,
    plannedFiles: row.planned_files ?? [],
    actualFilesChanged: row.actual_files_changed ?? [],
    testPlan: row.test_plan,
    testsPerformed: row.tests_performed ?? [],
    computerUseRequired: row.computer_use_required,
    proofScreenshotId: row.proof_screenshot_id,
    proofUrl: row.proof_url,
    finalAgentSummary: row.final_agent_summary,
    assignedAgentId: row.assigned_agent_id,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    archivedAt: row.archived_at,
    archivedReason: row.archived_reason,
    isTest: row.is_test,
    retentionExpiresAt: row.retention_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    doneAt: row.done_at,
  };
}

function normalizeProject(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    archivedAt: row.archived_at,
    archivedReason: row.archived_reason,
    isTest: row.is_test,
    retentionExpiresAt: row.retention_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function artifactDownloadUrl(artifactId) {
  return `${config.apiBase}/api/artifacts/${artifactId}/download`;
}

function boundedLimit(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

async function writeEvent(client, ticketId, actorAgentId, eventType, message, data = {}) {
  await client.query(
    `
      INSERT INTO ticket_events(ticket_id, actor_agent_id, event_type, message, data)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [ticketId, actorAgentId ?? null, eventType, message, JSON.stringify(data)],
  );
}

async function getTicketForUpdate(client, ticketId) {
  const result = await client.query("SELECT * FROM tickets WHERE id = $1 FOR UPDATE", [
    ticketId,
  ]);
  assertCondition(result.rowCount === 1, "ticket_not_found", "Ticket not found.", 404);
  return result.rows[0];
}

function assertActiveLease(row, agentId, leaseToken) {
  assertCondition(row.lease_token, "ticket_not_claimed", "Ticket is not claimed.", 409);
  assertCondition(row.assigned_agent_id === agentId, "wrong_agent", "Ticket is claimed by another agent.", 409);
  assertCondition(row.lease_token === leaseToken, "invalid_lease", "Lease token is invalid.", 409);
  assertCondition(
    row.lease_expires_at && new Date(row.lease_expires_at).getTime() > Date.now(),
    "lease_expired",
    "Ticket lease has expired.",
    409,
  );
}

async function extendActiveLease(client, ticketId, agentId, leaseToken) {
  const expiresAt = leaseExpiry();
  const updated = await client.query(
    `
      UPDATE tickets
      SET lease_expires_at = $4
      WHERE id = $1
        AND assigned_agent_id = $2
        AND lease_token = $3
      RETURNING *
    `,
    [ticketId, agentId, leaseToken, expiresAt],
  );
  await client.query(
    `
      UPDATE ticket_file_claims
      SET expires_at = $4
      WHERE ticket_id = $1
        AND agent_id = $2
        AND lease_token = $3
        AND released_at IS NULL
    `,
    [ticketId, agentId, leaseToken, expiresAt],
  );
  return updated.rows[0];
}

export async function createAgent({ name, kind = "unknown", externalKey = null, metadata = {} }) {
  const result = externalKey
    ? await query(
        `
          INSERT INTO agents(name, kind, external_key, metadata)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (external_key)
          WHERE external_key IS NOT NULL
          DO UPDATE SET
            name = EXCLUDED.name,
            kind = EXCLUDED.kind,
            metadata = agents.metadata || EXCLUDED.metadata
          RETURNING *
        `,
        [name, kind, externalKey, JSON.stringify(metadata)],
      )
    : await query(
        "INSERT INTO agents(name, kind, metadata) VALUES ($1, $2, $3) RETURNING *",
        [name, kind, JSON.stringify(metadata)],
      );
  return result.rows[0];
}

export async function createProject({ name, description = "", isTest = false, retentionExpiresAt = null }) {
  const result = await query(
    `
      INSERT INTO projects(name, description, is_test, retention_expires_at)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `,
    [name, description, isTest, retentionExpiresAt],
  );
  return normalizeProject(result.rows[0]);
}

export async function listProjects({
  q = "",
  limit = null,
  cursor = null,
  createdAfter = null,
  includeArchived = false,
  paginated = false,
} = {}) {
  const params = [];
  const where = [];
  if (!includeArchived) {
    where.push("archived_at IS NULL");
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }
  const after = parseIsoDate(createdAfter, "createdAfter");
  if (after) {
    params.push(after);
    where.push(`created_at >= $${params.length}`);
  }
  appendCursorFilter({ where, params, cursor });

  const safeLimit = paginated ? pageLimit(limit) : boundedLimit(limit, null, 200);
  let limitClause = "";
  if (safeLimit) {
    params.push(paginated ? safeLimit + 1 : safeLimit);
    limitClause = `LIMIT $${params.length}`;
  }

  const result = await query(
    `
      SELECT *
      FROM projects
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC, created_at DESC
      ${limitClause}
    `,
    params,
  );
  if (paginated) {
    return pageResult(result.rows, safeLimit, normalizeProject);
  }
  return result.rows.map(normalizeProject);
}

export async function countProjects({ q = "", createdAfter = null, includeArchived = false } = {}) {
  const params = [];
  const where = [];
  if (!includeArchived) {
    where.push("archived_at IS NULL");
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }
  const after = parseIsoDate(createdAfter, "createdAfter");
  if (after) {
    params.push(after);
    where.push(`created_at >= $${params.length}`);
  }
  const result = await query(
    `SELECT count(*)::int AS count FROM projects ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
    params,
  );
  return result.rows[0].count;
}

export async function getProject(projectId) {
  const result = await query("SELECT * FROM projects WHERE id = $1", [projectId]);
  assertCondition(result.rowCount === 1, "project_not_found", "Project not found.", 404);
  return normalizeProject(result.rows[0]);
}

export async function createTicket(input) {
  return withTransaction(async (client) =>
    withIdempotency(client, "create_ticket", input.idempotencyKey, input, async () => {
      const result = await client.query(
        `
          INSERT INTO tickets(
            project_id,
            title,
            why,
            description,
            status,
            planned_files,
            test_plan,
            computer_use_required,
            is_test,
            retention_expires_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING *
        `,
        [
          input.projectId,
          input.title,
          input.why,
          input.description,
          input.status ?? "Ready",
          input.plannedFiles ?? [],
          input.testPlan ?? "",
          input.computerUseRequired ?? false,
          input.isTest ?? false,
          input.retentionExpiresAt ?? null,
        ],
      );
      const ticket = normalizeTicket(result.rows[0]);
      await writeEvent(client, ticket.id, input.actorAgentId, "ticket.created", "Ticket created.", {
        title: ticket.title,
      });
      return { ticket };
    }),
  );
}

export async function getTicket(ticketId) {
  const result = await query("SELECT * FROM tickets WHERE id = $1", [ticketId]);
  assertCondition(result.rowCount === 1, "ticket_not_found", "Ticket not found.", 404);
  return normalizeTicket(result.rows[0]);
}

export async function listProjectTickets(projectId, {
  limit = null,
  cursor = null,
  q = "",
  createdAfter = null,
  includeArchived = false,
  paginated = false,
} = {}) {
  const params = [projectId];
  const where = ["project_id = $1"];
  if (!includeArchived) {
    where.push("archived_at IS NULL");
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(title ILIKE $${params.length} OR why ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }
  const after = parseIsoDate(createdAfter, "createdAfter");
  if (after) {
    params.push(after);
    where.push(`created_at >= $${params.length}`);
  }
  appendCursorFilter({ where, params, cursor });
  const safeLimit = paginated ? pageLimit(limit) : boundedLimit(limit, null, 200);
  let limitClause = "";
  if (safeLimit) {
    params.push(paginated ? safeLimit + 1 : safeLimit);
    limitClause = `LIMIT $${params.length}`;
  }
  const result = await query(
    `
      SELECT *
      FROM tickets
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC, id DESC
      ${limitClause}
    `,
    params,
  );
  if (paginated) {
    return pageResult(result.rows, safeLimit, normalizeTicket);
  }
  return result.rows.map(normalizeTicket);
}

export async function searchTickets({
  projectId = null,
  q = "",
  status = null,
  limit = null,
  cursor = null,
  createdAfter = null,
  includeArchived = false,
  paginated = false,
} = {}) {
  const params = [];
  const where = [];
  if (!includeArchived) {
    where.push("archived_at IS NULL");
  }
  if (projectId) {
    params.push(projectId);
    where.push(`project_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(title ILIKE $${params.length} OR why ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }
  const after = parseIsoDate(createdAfter, "createdAfter");
  if (after) {
    params.push(after);
    where.push(`created_at >= $${params.length}`);
  }
  appendCursorFilter({ where, params, cursor });
  const safeLimit = paginated ? pageLimit(limit) : boundedLimit(limit, 100, 200);
  params.push(paginated ? safeLimit + 1 : safeLimit);
  const limitIndex = params.length;
  const result = await query(
    `
      SELECT *
      FROM tickets
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC, id DESC
      LIMIT $${limitIndex}
    `,
    params,
  );
  if (paginated) {
    return pageResult(result.rows, safeLimit, normalizeTicket);
  }
  return result.rows.map(normalizeTicket);
}

export async function listAgentWork(agentId, {
  limit = null,
  cursor = null,
  includeArchived = false,
  paginated = false,
} = {}) {
  const params = [agentId];
  const where = [
    "assigned_agent_id = $1",
    "status NOT IN ('Done', 'Canceled')",
  ];
  if (!includeArchived) {
    where.push("archived_at IS NULL");
  }
  appendCursorFilter({ where, params, cursor });
  const safeLimit = paginated ? pageLimit(limit) : boundedLimit(limit, null, 200);
  let limitClause = "";
  if (safeLimit) {
    params.push(paginated ? safeLimit + 1 : safeLimit);
    limitClause = `LIMIT $${params.length}`;
  }
  const result = await query(
    `
      SELECT *
      FROM tickets
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC, id DESC
      ${limitClause}
    `,
    params,
  );
  if (paginated) {
    return pageResult(result.rows, safeLimit, normalizeTicket);
  }
  return result.rows.map(normalizeTicket);
}

export async function getAvailableTickets(projectId, {
  limit = null,
  cursor = null,
  createdAfter = null,
  includeArchived = false,
  paginated = false,
} = {}) {
  const params = [projectId];
  const where = [
    "t.project_id = $1",
    "t.status IN ('Ready', 'Reopened', 'Verification Failed')",
  ];
  if (!includeArchived) {
    where.push("t.archived_at IS NULL");
  }
  const after = parseIsoDate(createdAfter, "createdAfter");
  if (after) {
    params.push(after);
    where.push(`t.created_at >= $${params.length}`);
  }
  appendCursorFilter({ where, params, cursor, tableAlias: "t" });
  const safeLimit = paginated ? pageLimit(limit) : boundedLimit(limit, null, 200);
  let limitClause = "";
  if (safeLimit) {
    params.push(paginated ? safeLimit + 1 : safeLimit);
    limitClause = `LIMIT $${params.length}`;
  }
  const result = await query(
    `
      SELECT t.*
      FROM tickets t
      WHERE ${where.join(" AND ")}
        AND NOT EXISTS (
          SELECT 1
          FROM ticket_dependencies d
          JOIN tickets dep ON dep.id = d.depends_on_ticket_id
          WHERE d.ticket_id = t.id AND dep.status <> 'Done'
        )
      ORDER BY t.updated_at DESC, t.id DESC
      ${limitClause}
    `,
    params,
  );
  if (paginated) {
    return pageResult(result.rows, safeLimit, normalizeTicket);
  }
  return result.rows.map(normalizeTicket);
}

export async function addTicketDependency({ ticketId, dependsOnTicketId }) {
  const result = await query(
    `
      INSERT INTO ticket_dependencies(ticket_id, depends_on_ticket_id)
      VALUES ($1, $2)
      RETURNING *
    `,
    [ticketId, dependsOnTicketId],
  );
  return result.rows[0];
}

export async function getBlockers(ticketId) {
  const result = await query(
    `
      SELECT dep.id, dep.title, dep.status
      FROM ticket_dependencies d
      JOIN tickets dep ON dep.id = d.depends_on_ticket_id
      WHERE d.ticket_id = $1 AND dep.status <> 'Done'
      ORDER BY dep.created_at ASC
    `,
    [ticketId],
  );
  return result.rows;
}

export async function claimTicket({ ticketId, agentId, idempotencyKey }) {
  return withTransaction(async (client) =>
    withIdempotency(client, "claim_ticket", idempotencyKey, { ticketId, agentId }, async () => {
      const row = await getTicketForUpdate(client, ticketId);
      const now = Date.now();
      const activeLease =
        row.lease_token && row.lease_expires_at && new Date(row.lease_expires_at).getTime() > now;
      assertCondition(row.status !== "Done", "ticket_done", "Done tickets cannot be claimed.", 409);
      assertCondition(row.status !== "Canceled", "ticket_canceled", "Canceled tickets cannot be claimed.", 409);
      assertCondition(!activeLease, "ticket_already_claimed", "Ticket already has an active lease.", 409);

      const blockers = await client.query(
        `
          SELECT dep.id, dep.title, dep.status
          FROM ticket_dependencies d
          JOIN tickets dep ON dep.id = d.depends_on_ticket_id
          WHERE d.ticket_id = $1 AND dep.status <> 'Done'
        `,
        [ticketId],
      );
      assertCondition(blockers.rowCount === 0, "ticket_blocked_by_dependency", "Ticket has unfinished dependencies.", 409, {
        blockers: blockers.rows,
      });

      const leaseToken = token();
      const expiresAt = leaseExpiry();
      const updated = await client.query(
        `
          UPDATE tickets
          SET assigned_agent_id = $2,
              lease_token = $3,
              lease_expires_at = $4,
              status = 'Claimed'
          WHERE id = $1
          RETURNING *
        `,
        [ticketId, agentId, leaseToken, expiresAt],
      );
      await writeEvent(client, ticketId, agentId, "ticket.claimed", "Ticket claimed.", {
        leaseExpiresAt: expiresAt,
      });
      const ticket = normalizeTicket(updated.rows[0]);
      return { ticket, ...leasePayload(ticket, leaseToken) };
    }),
  );
}

export async function renewTicketLease({ ticketId, agentId, leaseToken }) {
  return withTransaction(async (client) => {
    const row = await getTicketForUpdate(client, ticketId);
    assertActiveLease(row, agentId, leaseToken);
    const expiresAt = leaseExpiry();
    const updated = await client.query(
      "UPDATE tickets SET lease_expires_at = $2 WHERE id = $1 RETURNING *",
      [ticketId, expiresAt],
    );
    await writeEvent(client, ticketId, agentId, "ticket.lease_renewed", "Ticket lease renewed.", {
      leaseExpiresAt: expiresAt,
    });
    const ticket = normalizeTicket(updated.rows[0]);
    return { ticket, ...leasePayload(ticket, leaseToken) };
  });
}

export async function releaseTicket({ ticketId, agentId, leaseToken }) {
  return withTransaction(async (client) => {
    const row = await getTicketForUpdate(client, ticketId);
    assertActiveLease(row, agentId, leaseToken);
    const nextStatus = mutableClaimedStatuses.has(row.status) ? "Ready" : row.status;
    await client.query(
      `
        UPDATE ticket_file_claims
        SET released_at = now()
        WHERE ticket_id = $1
          AND agent_id = $2
          AND released_at IS NULL
      `,
      [ticketId, agentId],
    );
    const updated = await client.query(
      `
        UPDATE tickets
        SET assigned_agent_id = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            status = $2
        WHERE id = $1
        RETURNING *
      `,
      [ticketId, nextStatus],
    );
    await writeEvent(client, ticketId, agentId, "ticket.released", "Ticket released.");
    return { ticket: normalizeTicket(updated.rows[0]) };
  });
}

export async function claimFiles({ ticketId, agentId, leaseToken, files, idempotencyKey }) {
  return withTransaction(async (client) =>
    withIdempotency(client, "claim_files", idempotencyKey, { ticketId, agentId, files }, async () => {
      assertCondition(Array.isArray(files) && files.length > 0, "files_required", "At least one file path or pattern is required.");
      const row = await getTicketForUpdate(client, ticketId);
      assertActiveLease(row, agentId, leaseToken);

      const active = await client.query(
        `
          SELECT c.*, t.title AS ticket_title
          FROM ticket_file_claims c
          JOIN tickets t ON t.id = c.ticket_id
          WHERE c.released_at IS NULL
            AND c.expires_at > now()
            AND t.status NOT IN ('Done', 'Canceled')
            AND c.ticket_id <> $1
        `,
        [ticketId],
      );

      const normalized = files.map(normalizePathPattern);
      const conflicts = [];
      for (const wanted of normalized) {
        for (const claim of active.rows) {
          if (patternsOverlap(wanted, claim.normalized_pattern)) {
            conflicts.push({
              requested: wanted,
              existing: claim.normalized_pattern,
              ticketId: claim.ticket_id,
              ticketTitle: claim.ticket_title,
              agentId: claim.agent_id,
              expiresAt: claim.expires_at,
            });
          }
        }
      }

      assertCondition(conflicts.length === 0, "file_claim_conflict", "One or more files are already claimed.", 409, {
        conflicts,
      });

      const renewedRow = await extendActiveLease(client, ticketId, agentId, leaseToken);
      const claims = [];
      for (const item of normalized) {
        const inserted = await client.query(
          `
            INSERT INTO ticket_file_claims(
              ticket_id,
              agent_id,
              path_pattern,
              normalized_pattern,
              lease_token,
              expires_at
            )
            VALUES ($1, $2, $3, $3, $4, $5)
            RETURNING *
          `,
          [ticketId, agentId, item, leaseToken, renewedRow.lease_expires_at],
        );
        claims.push(inserted.rows[0]);
      }

      await writeEvent(client, ticketId, agentId, "files.claimed", "Files claimed.", {
        files: normalized,
      });
      const ticket = normalizeTicket(renewedRow);
      return { claims, lease: leasePayload(ticket, leaseToken) };
    }),
  );
}

export async function releaseFiles({ ticketId, agentId, leaseToken, files = [] }) {
  return withTransaction(async (client) => {
    const row = await getTicketForUpdate(client, ticketId);
    assertActiveLease(row, agentId, leaseToken);
    const normalized = files.map(normalizePathPattern);
    const params = [ticketId, agentId];
    let filter = "";
    if (normalized.length > 0) {
      params.push(normalized);
      filter = "AND normalized_pattern = ANY($3)";
    }
    const result = await client.query(
      `
        UPDATE ticket_file_claims
        SET released_at = now()
        WHERE ticket_id = $1
          AND agent_id = $2
          AND released_at IS NULL
          ${filter}
        RETURNING *
      `,
      params,
    );
    await writeEvent(client, ticketId, agentId, "files.released", "Files released.", {
      files: normalized.length > 0 ? normalized : "all",
    });
    const renewed = await extendActiveLease(client, ticketId, agentId, leaseToken);
    return { released: result.rows, lease: leasePayload(normalizeTicket(renewed), leaseToken) };
  });
}

export async function getFileClaims({
  projectId = null,
  ticketId = null,
  activeOnly = true,
  limit = null,
  cursor = null,
  includeArchived = false,
  paginated = false,
} = {}) {
  const params = [];
  const where = [];
  if (projectId) {
    params.push(projectId);
    where.push(`t.project_id = $${params.length}`);
  }
  if (ticketId) {
    params.push(ticketId);
    where.push(`c.ticket_id = $${params.length}`);
  }
  if (activeOnly) {
    where.push("c.released_at IS NULL");
    where.push("c.expires_at > now()");
    where.push("t.status NOT IN ('Done', 'Canceled')");
  }
  if (!includeArchived) {
    where.push("t.archived_at IS NULL");
    where.push("p.archived_at IS NULL");
  }
  appendCursorFilter({ where, params, cursor, column: "created_at", tableAlias: "c" });
  const safeLimit = paginated ? pageLimit(limit) : boundedLimit(limit, null, 200);
  let limitClause = "";
  if (safeLimit) {
    params.push(paginated ? safeLimit + 1 : safeLimit);
    limitClause = `LIMIT $${params.length}`;
  }

  const result = await query(
    `
      SELECT c.*, t.title AS ticket_title, p.name AS project_name
      FROM ticket_file_claims c
      JOIN tickets t ON t.id = c.ticket_id
      JOIN projects p ON p.id = t.project_id
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY c.created_at DESC, c.id DESC
      ${limitClause}
    `,
    params,
  );
  if (paginated) {
    return pageResult(result.rows, safeLimit, (row) => row, "created_at");
  }
  return result.rows;
}

export async function updateTicket({ ticketId, agentId, leaseToken, patch, idempotencyKey }) {
  return withTransaction(async (client) =>
    withIdempotency(client, "update_ticket", idempotencyKey, { ticketId, agentId, patch }, async () => {
      const row = await getTicketForUpdate(client, ticketId);
      assertActiveLease(row, agentId, leaseToken);

      const merged = {
        title: patch.title ?? row.title,
        why: patch.why ?? row.why,
        description: patch.description ?? row.description,
        plannedFiles: patch.plannedFiles ?? row.planned_files,
        actualFilesChanged: patch.actualFilesChanged ?? row.actual_files_changed,
        testPlan: patch.testPlan ?? row.test_plan,
        proofUrl: patch.proofUrl ?? row.proof_url,
        finalAgentSummary: patch.finalAgentSummary ?? row.final_agent_summary,
        computerUseRequired: patch.computerUseRequired ?? row.computer_use_required,
      };

      const updated = await client.query(
        `
          UPDATE tickets
          SET title = $2,
              why = $3,
              description = $4,
              planned_files = $5,
              actual_files_changed = $6,
              test_plan = $7,
              proof_url = $8,
              final_agent_summary = $9,
              computer_use_required = $10,
              status = CASE WHEN status = 'Claimed' THEN 'In Progress' ELSE status END
          WHERE id = $1
          RETURNING *
        `,
        [
          ticketId,
          merged.title,
          merged.why,
          merged.description,
          merged.plannedFiles,
          merged.actualFilesChanged,
          merged.testPlan,
          merged.proofUrl,
          merged.finalAgentSummary,
          merged.computerUseRequired,
        ],
      );
      await writeEvent(client, ticketId, agentId, "ticket.updated", "Ticket updated.", patch);
      const renewed = await extendActiveLease(client, ticketId, agentId, leaseToken);
      return { ticket: normalizeTicket(renewed), lease: leasePayload(normalizeTicket(renewed), leaseToken) };
    }),
  );
}

export async function recordTest({ ticketId, agentId, leaseToken, command, status, output = "", idempotencyKey }) {
  return withTransaction(async (client) =>
    withIdempotency(
      client,
      "record_test",
      idempotencyKey,
      { ticketId, agentId, command, status, output },
      async () => {
        const row = await getTicketForUpdate(client, ticketId);
        assertActiveLease(row, agentId, leaseToken);
        const testRun = await client.query(
          `
            INSERT INTO test_runs(ticket_id, agent_id, command, status, output)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
          `,
          [ticketId, agentId, command, status, output],
        );
        const entry = `${status}: ${command}`;
        const updated = await client.query(
          `
            UPDATE tickets
            SET tests_performed = array_append(tests_performed, $2),
                status = CASE WHEN status = 'Claimed' THEN 'In Progress' ELSE status END
            WHERE id = $1
            RETURNING *
          `,
          [ticketId, entry],
        );
        await writeEvent(client, ticketId, agentId, "test.recorded", "Test run recorded.", {
          command,
          status,
        });
        const renewed = await extendActiveLease(client, ticketId, agentId, leaseToken);
        return { testRun: testRun.rows[0], ticket: normalizeTicket(renewed), lease: leasePayload(normalizeTicket(renewed), leaseToken) };
      },
    ),
  );
}

export async function attachArtifact({
  ticketId,
  agentId,
  leaseToken,
  type,
  filename,
  mimeType = "application/octet-stream",
  content,
  label = "",
  idempotencyKey,
}) {
  const stored = await putArtifactObject({ ticketId, filename, mimeType, content });
  return withTransaction(async (client) =>
    withIdempotency(
      client,
      "attach_artifact",
      idempotencyKey,
      { ticketId, agentId, type, filename, mimeType, label, checksum: stored.checksum },
      async () => {
        const row = await getTicketForUpdate(client, ticketId);
        assertActiveLease(row, agentId, leaseToken);

        const object = await client.query(
          `
            INSERT INTO artifact_objects(object_key, filename, mime_type, size_bytes, checksum)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
          `,
          [stored.objectKey, stored.filename, stored.mimeType, stored.sizeBytes, stored.checksum],
        );
        const artifact = await client.query(
          `
            INSERT INTO proof_artifacts(ticket_id, agent_id, artifact_object_id, type, label)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
          `,
          [ticketId, agentId, object.rows[0].id, type, label],
        );

        if (type === "screenshot" || type === "computer-use-screenshot" || type === "browser-screenshot") {
          await client.query(
            `
              UPDATE tickets
              SET proof_screenshot_id = COALESCE(proof_screenshot_id, $2),
                  status = CASE
                    WHEN status IN ('Claimed', 'In Progress', 'Verification Failed') THEN 'Proof Submitted'
                    ELSE status
                  END
              WHERE id = $1
            `,
            [ticketId, artifact.rows[0].id],
          );
        }

        await writeEvent(client, ticketId, agentId, "proof.attached", "Proof artifact attached.", {
          type,
          filename,
          sizeBytes: stored.sizeBytes,
          checksum: stored.checksum,
        });

        const renewed = await extendActiveLease(client, ticketId, agentId, leaseToken);
        return {
          artifact: {
            ...artifact.rows[0],
            downloadUrl: artifactDownloadUrl(artifact.rows[0].id),
            presignedUrl: await presignedArtifactUrl(stored.objectKey),
          },
          object: object.rows[0],
          ticket: normalizeTicket(renewed),
          lease: leasePayload(normalizeTicket(renewed), leaseToken),
          downloadUrl: artifactDownloadUrl(artifact.rows[0].id),
          presignedUrl: await presignedArtifactUrl(stored.objectKey),
        };
      },
    ),
  );
}

export async function listProofArtifacts(ticketId) {
  const result = await query(
    `
      SELECT
        pa.*,
        ao.object_key,
        ao.filename,
        ao.mime_type,
        ao.size_bytes,
        ao.checksum
      FROM proof_artifacts pa
      JOIN artifact_objects ao ON ao.id = pa.artifact_object_id
      WHERE pa.ticket_id = $1
      ORDER BY pa.created_at DESC
    `,
    [ticketId],
  );
  return result.rows.map((row) => ({
    ...row,
    downloadUrl: artifactDownloadUrl(row.id),
  }));
}

export async function getArtifactUrl(objectKey) {
  return presignedArtifactUrl(objectKey);
}

export async function getArtifactById(artifactId) {
  const result = await query(
    `
      SELECT
        pa.*,
        ao.object_key,
        ao.filename,
        ao.mime_type,
        ao.size_bytes,
        ao.checksum
      FROM proof_artifacts pa
      JOIN artifact_objects ao ON ao.id = pa.artifact_object_id
      WHERE pa.id = $1
    `,
    [artifactId],
  );
  assertCondition(result.rowCount === 1, "artifact_not_found", "Artifact not found.", 404);
  const artifact = result.rows[0];
  return {
    ...artifact,
    downloadUrl: artifactDownloadUrl(artifact.id),
    presignedUrl: await presignedArtifactUrl(artifact.object_key),
  };
}

export async function validateTicketCompletion(ticketId) {
  return validateTicketCompletionWithClient({ query }, ticketId);
}

async function validateTicketCompletionWithClient(client, ticketId) {
  const result = await client.query("SELECT * FROM tickets WHERE id = $1", [ticketId]);
  assertCondition(result.rowCount === 1, "ticket_not_found", "Ticket not found.", 404);
  const ticket = normalizeTicket(result.rows[0]);
  const artifactCount = await client.query(
    "SELECT count(*)::int AS count FROM proof_artifacts WHERE ticket_id = $1",
    [ticketId],
  );
  const hasArtifact = artifactCount.rows[0].count > 0 || Boolean(ticket.proofScreenshotId);
  const checklist = {
    testsPerformed: ticket.testsPerformed.length > 0,
    proofArtifact: hasArtifact,
    proofUrl: ticket.proofUrl.trim().length > 0,
    finalAgentSummary: ticket.finalAgentSummary.trim().length > 0,
    actualFilesChanged: ticket.actualFilesChanged.length > 0,
  };
  return {
    ok: Object.values(checklist).every(Boolean),
    checklist,
    ticket,
  };
}

export async function submitDone({ ticketId, agentId, leaseToken, finalAgentSummary, proofUrl, actualFilesChanged }) {
  const result = await withTransaction(async (client) => {
    const row = await getTicketForUpdate(client, ticketId);
    assertActiveLease(row, agentId, leaseToken);
    await client.query(
      `
        UPDATE tickets
        SET final_agent_summary = COALESCE(NULLIF($2, ''), final_agent_summary),
            proof_url = COALESCE(NULLIF($3, ''), proof_url),
            actual_files_changed = CASE
              WHEN cardinality($4::text[]) > 0 THEN $4::text[]
              ELSE actual_files_changed
            END,
            status = 'Proof Submitted'
        WHERE id = $1
      `,
      [ticketId, finalAgentSummary ?? "", proofUrl ?? "", actualFilesChanged ?? []],
    );

    const validation = await validateTicketCompletionWithClient(client, ticketId);
    if (!validation.ok) {
      await client.query("UPDATE tickets SET status = 'Verification Failed' WHERE id = $1", [ticketId]);
      await writeEvent(client, ticketId, agentId, "ticket.completion_rejected", "Completion gate rejected Done.", {
        checklist: validation.checklist,
      });
      return { rejected: true, checklist: validation.checklist };
    }

    const updated = await client.query(
      `
        UPDATE tickets
        SET status = 'Done',
            done_at = now(),
            lease_token = NULL,
            lease_expires_at = NULL
        WHERE id = $1
        RETURNING *
      `,
      [ticketId],
    );
    await client.query(
      `
        UPDATE ticket_file_claims
        SET released_at = now()
        WHERE ticket_id = $1
          AND released_at IS NULL
      `,
      [ticketId],
    );
    await writeEvent(client, ticketId, agentId, "ticket.done", "Ticket marked Done.", {
      checklist: validation.checklist,
    });
    return { ticket: normalizeTicket(updated.rows[0]), checklist: validation.checklist };
  });

  if (result?.rejected) {
    throw new ObjectiveError(
      "completion_gate_failed",
      "Ticket cannot be marked Done until all required evidence exists.",
      409,
      result.checklist,
    );
  }

  return result;
}

export async function markBlocked({ ticketId, agentId, leaseToken, reason }) {
  return withTransaction(async (client) => {
    const row = await getTicketForUpdate(client, ticketId);
    assertActiveLease(row, agentId, leaseToken);
    const updated = await client.query(
      "UPDATE tickets SET status = 'Blocked' WHERE id = $1 RETURNING *",
      [ticketId],
    );
    await writeEvent(client, ticketId, agentId, "ticket.blocked", reason || "Ticket blocked.");
    const renewed = await extendActiveLease(client, ticketId, agentId, leaseToken);
    return { ticket: normalizeTicket(renewed), lease: leasePayload(normalizeTicket(renewed), leaseToken) };
  });
}

export async function rejectProof({ ticketId, actorAgentId = null, reason }) {
  return withTransaction(async (client) => {
    const row = await getTicketForUpdate(client, ticketId);
    assertCondition(row.status !== "Done", "ticket_done", "Done tickets cannot have proof rejected. Reopen first.", 409);
    const updated = await client.query(
      "UPDATE tickets SET status = 'Verification Failed' WHERE id = $1 RETURNING *",
      [ticketId],
    );
    await writeEvent(client, ticketId, actorAgentId, "proof.rejected", reason || "Proof rejected.");
    return { ticket: normalizeTicket(updated.rows[0]) };
  });
}

export async function reopenTicket({ ticketId, actorAgentId = null, reason = "" }) {
  return withTransaction(async (client) => {
    await getTicketForUpdate(client, ticketId);
    const updated = await client.query(
      `
        UPDATE tickets
        SET status = 'Reopened',
            done_at = NULL,
            assigned_agent_id = NULL,
            lease_token = NULL,
            lease_expires_at = NULL
        WHERE id = $1
        RETURNING *
      `,
      [ticketId],
    );
    await writeEvent(client, ticketId, actorAgentId, "ticket.reopened", reason || "Ticket reopened.");
    return { ticket: normalizeTicket(updated.rows[0]) };
  });
}

export async function heartbeat({ agentId, ticketId = null, sessionId = null, metadata = {} }) {
  await query("UPDATE agents SET last_seen_at = now() WHERE id = $1", [agentId]);
  const result = await query(
    `
      INSERT INTO agent_heartbeats(agent_id, session_id, ticket_id, metadata)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `,
    [agentId, sessionId, ticketId, JSON.stringify(metadata)],
  );
  return result.rows[0];
}

export async function getTicketEvents(ticketId, { limit = 50, cursor = null, includeData = true, paginated = false } = {}) {
  const safeLimit = paginated ? pageLimit(limit, 50) : boundedLimit(limit, 50, 200);
  const params = [ticketId];
  const where = ["ticket_id = $1"];
  appendCursorFilter({ where, params, cursor, column: "created_at" });
  params.push(paginated ? safeLimit + 1 : safeLimit);
  const limitIndex = params.length;
  const result = await query(
    `
      SELECT *
      FROM ticket_events
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${limitIndex}
    `,
    params,
  );
  const visibleDesc = result.rows.slice(0, safeLimit);
  const output = visibleDesc.slice().reverse();
  const rows = includeData ? output : output.map(({ data, ...row }) => row);
  if (paginated) {
    return {
      items: rows,
      count: rows.length,
      hasMore: result.rows.length > safeLimit,
      nextCursor: result.rows.length > safeLimit ? cursorFromRow(visibleDesc.at(-1), "created_at") : null,
    };
  }
  return rows;
}
