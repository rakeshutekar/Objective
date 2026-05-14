import { config } from "./config.js";
import { ObjectiveError } from "./errors.js";

export function pageLimit(value, fallback = config.defaultPageSize) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, config.maxPageSize);
}

export function encodeCursor(cursor) {
  if (!cursor) return null;
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(value) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || !decoded.id) {
      throw new Error("invalid cursor shape");
    }
    return decoded;
  } catch {
    throw new ObjectiveError("invalid_cursor", "cursor must be a valid Objective pagination cursor.", 400);
  }
}

export function cursorFromRow(row, timeColumn = "updated_at") {
  if (!row) return null;
  return encodeCursor({
    at: row[timeColumn],
    id: row.id,
  });
}

export function appendCursorFilter({ where, params, cursor, column = "updated_at", tableAlias = "" }) {
  const decoded = decodeCursor(cursor);
  if (!decoded) return;
  const qualifiedColumn = tableAlias ? `${tableAlias}.${column}` : column;
  const qualifiedId = tableAlias ? `${tableAlias}.id` : "id";
  params.push(decoded.at);
  const atIndex = params.length;
  params.push(decoded.id);
  const idIndex = params.length;
  where.push(`(${qualifiedColumn}, ${qualifiedId}) < ($${atIndex}, $${idIndex})`);
}

export function pageResult(rows, limit, itemMapper = (item) => item, timeColumn = "updated_at") {
  const visible = rows.slice(0, limit);
  const extra = rows.length > limit;
  return {
    items: visible.map(itemMapper),
    count: visible.length,
    hasMore: extra,
    nextCursor: extra ? cursorFromRow(visible[visible.length - 1], timeColumn) : null,
  };
}
