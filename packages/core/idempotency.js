import crypto from "node:crypto";
import { ObjectiveError } from "./errors.js";
import { stableJson } from "./json.js";

function hashPayload(payload) {
  return crypto.createHash("sha256").update(stableJson(payload)).digest("hex");
}

export async function withIdempotency(client, scope, idempotencyKey, payload, fn) {
  if (!idempotencyKey) return fn();

  const requestHash = hashPayload(payload);
  const existing = await client.query(
    `
      SELECT request_hash, response
      FROM idempotency_keys
      WHERE scope = $1 AND idempotency_key = $2
    `,
    [scope, idempotencyKey],
  );

  if (existing.rowCount > 0) {
    const row = existing.rows[0];
    if (row.request_hash !== requestHash) {
      throw new ObjectiveError(
        "idempotency_conflict",
        "The idempotency key was reused with a different request payload.",
        409,
      );
    }
    return row.response;
  }

  const response = await fn();
  await client.query(
    `
      INSERT INTO idempotency_keys(scope, idempotency_key, request_hash, response)
      VALUES ($1, $2, $3, $4)
    `,
    [scope, idempotencyKey, requestHash, JSON.stringify(response)],
  );
  return response;
}
