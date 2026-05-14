import assert from "node:assert/strict";
import test from "node:test";
import { archiveProject } from "../packages/core/archive.js";
import {
  createProject,
  listProjects,
  countProjects,
} from "../packages/core/lifecycle.js";
import { closePool } from "../packages/db/client.js";
import { migrate } from "../packages/db/migrate.js";

test("project pagination supports cursors, search, and archive filtering", async () => {
  await migrate();
  const prefix = `Phase 15 ${Date.now()} ${Math.random().toString(36).slice(2)}`;
  const created = [];
  for (let index = 0; index < 6; index += 1) {
    created.push(
      await createProject({
        name: `${prefix} ${index}`,
        description: "Pagination guard",
        isTest: true,
      }),
    );
  }

  await archiveProject({ projectId: created[5].id, reason: "phase15 archive" });

  const first = await listProjects({ q: prefix, limit: 2, paginated: true });
  assert.equal(first.items.length, 2);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  assert.ok(first.items.every((project) => project.archivedAt === null));

  const second = await listProjects({ q: prefix, limit: 2, cursor: first.nextCursor, paginated: true });
  assert.equal(second.items.length, 2);
  assert.notEqual(second.items[0].id, first.items[0].id);

  const totalActive = await countProjects({ q: prefix });
  assert.equal(totalActive, 5);

  const withArchived = await listProjects({ q: prefix, limit: 10, includeArchived: true, paginated: true });
  assert.equal(withArchived.items.length, 6);
  assert.ok(withArchived.items.some((project) => project.archivedAt));
});

test.after(async () => {
  await closePool();
});
