import crypto from "node:crypto";
import { closePool, query } from "./client.js";

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function seed() {
  const project = await query(
    `
      INSERT INTO projects(name, description)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      RETURNING *
    `,
    ["Objective Local", "Local project for agent ticket execution."],
  );

  const projectId =
    project.rows[0]?.id ??
    (await query("SELECT id FROM projects WHERE name = $1", ["Objective Local"])).rows[0].id;

  const agent = await query(
    `
      INSERT INTO agents(name, kind)
      VALUES ($1, $2)
      RETURNING *
    `,
    [`Local Agent ${Date.now()}`, "unknown"],
  );

  await query(
    `
      INSERT INTO api_keys(agent_id, label, key_hash)
      VALUES ($1, $2, $3)
      ON CONFLICT (key_hash) DO NOTHING
    `,
    [agent.rows[0].id, "Development agent key", hash("dev-agent-key")],
  );

  await query(
    `
      INSERT INTO tickets(project_id, title, why, description, status, test_plan, computer_use_required)
      VALUES ($1, $2, $3, $4, 'Ready', $5, true)
    `,
    [
      projectId,
      "Verify Objective local workflow",
      "Objective needs a default ticket that exercises the local agent loop.",
      "Use this ticket to validate claim, file lock, test, proof, and completion flows.",
      "Run the Objective health checks and attach proof.",
    ],
  );

  console.log("Seeded Objective development data");
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  seed()
    .then(() => closePool())
    .catch(async (err) => {
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
