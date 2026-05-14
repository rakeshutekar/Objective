import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../apps/web/server.js";
import { closePool } from "../packages/db/client.js";
import { migrate } from "../packages/db/migrate.js";

test("human UI serves dashboard assets and Objective board structure", async () => {
  await migrate();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const html = await fetch(`${base}/`).then((response) => response.text());
    const css = await fetch(`${base}/styles.css`).then((response) => response.text());
    const js = await fetch(`${base}/app.js`).then((response) => response.text());

    assert.match(html, /Dashboard/);
    assert.match(html, /Project Board/);
    assert.match(html, /File Locks/);
    assert.match(css, /\.board/);
    assert.match(css, /\.detail-panel/);
    assert.match(js, /renderDetail/);
    assert.match(js, /completion/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(async () => {
  await closePool();
});
