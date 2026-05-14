import { query, withTransaction } from "../db/client.js";
import { assertUuid } from "./validation.js";

const releasableStatuses = [
  "Claimed",
  "In Progress",
  "Blocked",
  "Proof Submitted",
  "Verification Failed",
];

async function releaseArchivedProjectWork(client, projectId, reason) {
  const claims = await client.query(
    `
      UPDATE ticket_file_claims c
      SET released_at = now()
      FROM tickets t
      WHERE c.ticket_id = t.id
        AND t.project_id = $1
        AND c.released_at IS NULL
      RETURNING c.ticket_id
    `,
    [projectId],
  );
  const tickets = await client.query(
    `
      UPDATE tickets
      SET assigned_agent_id = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          status = CASE
            WHEN status = ANY($2::ticket_status[]) THEN 'Ready'::ticket_status
            ELSE status
          END
      WHERE project_id = $1
        AND (assigned_agent_id IS NOT NULL OR lease_token IS NOT NULL OR lease_expires_at IS NOT NULL)
      RETURNING id
    `,
    [projectId, releasableStatuses],
  );
  await writeArchiveReleaseEvents(client, tickets.rows.map((row) => row.id), reason);
  return { releasedClaims: claims.rowCount, releasedTickets: tickets.rowCount };
}

async function releaseArchivedTicketWork(client, ticketId, reason) {
  const claims = await client.query(
    `
      UPDATE ticket_file_claims
      SET released_at = now()
      WHERE ticket_id = $1
        AND released_at IS NULL
      RETURNING id
    `,
    [ticketId],
  );
  const tickets = await client.query(
    `
      UPDATE tickets
      SET assigned_agent_id = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          status = CASE
            WHEN status = ANY($2::ticket_status[]) THEN 'Ready'::ticket_status
            ELSE status
          END
      WHERE id = $1
        AND (assigned_agent_id IS NOT NULL OR lease_token IS NOT NULL OR lease_expires_at IS NOT NULL)
      RETURNING id
    `,
    [ticketId, releasableStatuses],
  );
  await writeArchiveReleaseEvents(client, tickets.rows.map((row) => row.id), reason);
  return { releasedClaims: claims.rowCount, releasedTickets: tickets.rowCount };
}

async function writeArchiveReleaseEvents(client, ticketIds, reason) {
  if (ticketIds.length === 0) return;
  await client.query(
    `
      INSERT INTO ticket_events(ticket_id, event_type, message, data)
      SELECT id, 'ticket.archive_released', 'Archived ticket lease and file claims released.', $2
      FROM unnest($1::uuid[]) AS ticket_ids(id)
    `,
    [ticketIds, JSON.stringify({ reason })],
  );
}

export async function archiveProject({ projectId, reason = "Archived by Objective.", archiveTickets = true }) {
  assertUuid(projectId, "projectId");
  return withTransaction(async (client) => {
    const project = await client.query(
      `
        UPDATE projects
        SET archived_at = COALESCE(archived_at, now()),
            archived_reason = $2
        WHERE id = $1
        RETURNING *
      `,
      [projectId, reason],
    );
    let released = { releasedClaims: 0, releasedTickets: 0 };
    if (archiveTickets) {
      await client.query(
        `
          UPDATE tickets
          SET archived_at = COALESCE(archived_at, now()),
              archived_reason = $2
          WHERE project_id = $1
            AND archived_at IS NULL
        `,
        [projectId, reason],
      );
      released = await releaseArchivedProjectWork(client, projectId, reason);
    }
    return { project: project.rows[0], archivedTickets: archiveTickets, ...released };
  });
}

export async function archiveTicket({ ticketId, reason = "Archived by Objective." }) {
  assertUuid(ticketId, "ticketId");
  return withTransaction(async (client) => {
    await client.query(
      `
        UPDATE tickets
        SET archived_at = COALESCE(archived_at, now()),
            archived_reason = $2
        WHERE id = $1
        RETURNING *
      `,
      [ticketId, reason],
    );
    const released = await releaseArchivedTicketWork(client, ticketId, reason);
    const ticket = await client.query("SELECT * FROM tickets WHERE id = $1", [ticketId]);
    return { ticket: ticket.rows[0], ...released };
  });
}

export async function cleanupTestRuns({ olderThan = new Date(), reason = "Objective test retention cleanup." } = {}) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `
        UPDATE projects
        SET archived_at = COALESCE(archived_at, now()),
            archived_reason = $2
        WHERE is_test = true
          AND archived_at IS NULL
          AND COALESCE(retention_expires_at, created_at) <= $1
        RETURNING id
      `,
      [olderThan, reason],
    );
    const ticketResult = await client.query(
      `
        UPDATE tickets
        SET archived_at = COALESCE(archived_at, now()),
            archived_reason = $2
        WHERE is_test = true
          AND archived_at IS NULL
          AND COALESCE(retention_expires_at, created_at) <= $1
        RETURNING id
      `,
      [olderThan, reason],
    );
    let releasedClaims = 0;
    let releasedTickets = 0;
    for (const row of ticketResult.rows) {
      const released = await releaseArchivedTicketWork(client, row.id, reason);
      releasedClaims += released.releasedClaims;
      releasedTickets += released.releasedTickets;
    }
    return {
      archivedProjects: result.rows.map((row) => row.id),
      count: result.rowCount,
      releasedClaims,
      releasedTickets,
    };
  });
}
