import { ObjectiveError } from "./errors.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const uuidErrorCodes = {
  agentId: "invalid_agent_id_format",
  projectId: "invalid_project_id_format",
  ticketId: "invalid_ticket_id_format",
  dependsOnTicketId: "invalid_ticket_id_format",
  artifactId: "invalid_artifact_id_format",
};

export function assertUuid(value, field) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ObjectiveError(
      uuidErrorCodes[field] ?? "invalid_uuid_format",
      `${field} must be a UUID.`,
      400,
      { field },
    );
  }
  return value;
}

export function optionalUuid(value, field) {
  if (value === undefined || value === null || value === "") return null;
  return assertUuid(value, field);
}

export function assertEnum(value, field, allowed) {
  if (value === undefined || value === null || value === "") return null;
  if (!allowed.includes(value)) {
    throw new ObjectiveError(
      `invalid_${field}`,
      `${field} must be one of: ${allowed.join(", ")}.`,
      400,
      { field, allowed },
    );
  }
  return value;
}

export function parseIsoDate(value, field) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ObjectiveError("invalid_date", `${field} must be a valid ISO date.`, 400, { field });
  }
  return date;
}

export function responseMode(value = "full") {
  const mode = value || "full";
  if (mode !== "summary" && mode !== "full") {
    throw new ObjectiveError("invalid_response_mode", "responseMode must be summary or full.", 400, {
      field: "responseMode",
      allowed: ["summary", "full"],
    });
  }
  return mode;
}

export function boolParam(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return fallback;
}

export function normalizeDatabaseError(err) {
  if (err?.code === "22P02") {
    return new ObjectiveError("invalid_uuid_format", "One or more ID fields must be valid UUIDs.", 400);
  }
  return err;
}
