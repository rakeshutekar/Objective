import { query, withTransaction } from "../db/client.js";
import { assertUuid } from "./validation.js";

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
    }
    return { project: project.rows[0], archivedTickets: archiveTickets };
  });
}

export async function archiveTicket({ ticketId, reason = "Archived by Objective." }) {
  assertUuid(ticketId, "ticketId");
  const result = await query(
    `
      UPDATE tickets
      SET archived_at = COALESCE(archived_at, now()),
          archived_reason = $2
      WHERE id = $1
      RETURNING *
    `,
    [ticketId, reason],
  );
  return { ticket: result.rows[0] };
}

export async function cleanupTestRuns({ olderThan = new Date(), reason = "Objective test retention cleanup." } = {}) {
  const result = await query(
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
  await query(
    `
      UPDATE tickets
      SET archived_at = COALESCE(archived_at, now()),
          archived_reason = $2
      WHERE is_test = true
        AND archived_at IS NULL
        AND COALESCE(retention_expires_at, created_at) <= $1
    `,
    [olderThan, reason],
  );
  return { archivedProjects: result.rows.map((row) => row.id), count: result.rowCount };
}
