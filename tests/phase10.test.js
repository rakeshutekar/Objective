import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createServer } from "../apps/web/server.js";
import { closePool } from "../packages/db/client.js";
import { migrate } from "../packages/db/migrate.js";

function readFirstSseChunk(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.includes("\n\n")) {
          req.destroy();
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        }
      });
    });
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("Timed out waiting for SSE chunk"));
    });
    req.on("error", (err) => {
      if (err.code === "ECONNRESET" && err.message === "socket hang up") return;
      reject(err);
    });
  });
}

test("realtime endpoint emits Objective SSE snapshots", async () => {
  await migrate();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const event = await readFirstSseChunk(`${base}/api/events`);
    assert.equal(event.statusCode, 200);
    assert.match(event.headers["content-type"], /text\/event-stream/);
    assert.match(event.body, /event: objective/);
    assert.match(event.body, /ticketCounts/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(async () => {
  await closePool();
});
