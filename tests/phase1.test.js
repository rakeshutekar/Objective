import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../apps/web/server.js";

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
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
