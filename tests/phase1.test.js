import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../apps/web/server.js";
import { closePool } from "../packages/db/client.js";

test("web server exposes health endpoint", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, "objective-web");
    assert.equal(body.database, "ok");
    assert.equal(body.storage, "ok");
    assert.ok(Number.isInteger(body.checks.database.latencyMs));
    assert.ok(Number.isInteger(body.checks.storage.latencyMs));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(async () => {
  await closePool();
});
