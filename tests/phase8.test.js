import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("Codex and Claude plugin manifests expose Objective", async () => {
  const codex = await json("plugins/codex/.codex-plugin/plugin.json");
  const claude = await json("plugins/claude/.claude-plugin/plugin.json");
  const codexMcp = await json("plugins/codex/.mcp.json");
  const claudeMcp = await json("plugins/claude/.mcp.json");

  assert.equal(codex.name, "objective");
  assert.equal(claude.name, "objective");
  assert.equal(codex.skills, "./skills/");
  assert.equal(codex.mcpServers, "./.mcp.json");
  assert.equal(codexMcp.mcpServers.objective.command, "node");
  assert.equal(codexMcp.mcpServers.objective.args[0], "./server.js");
  assert.equal(codexMcp.mcpServers.objective.env.OBJECTIVE_WORKSPACE_ROOT, undefined);
  assert.equal(claudeMcp.mcpServers.objective.command, "node");
  assert.equal(claudeMcp.mcpServers.objective.args[0], "${CLAUDE_PLUGIN_ROOT}/server.js");
  assert.equal(claudeMcp.mcpServers.objective.env.OBJECTIVE_WORKSPACE_ROOT, undefined);
});

test("plugin skills define the same Objective workflow", async () => {
  const codexSkill = await readFile("plugins/codex/skills/objective/SKILL.md", "utf8");
  const claudeSkill = await readFile("plugins/claude/skills/objective/SKILL.md", "utf8");
  assert.ok(codexSkill.includes("objective_agent_bootstrap"));
  assert.ok(codexSkill.includes("objective_claim_ticket_and_files"));
  assert.ok(codexSkill.includes("Completion Gate"));
  assert.ok(claudeSkill.includes("objective_agent_bootstrap"));
  assert.ok(claudeSkill.includes("objective_claim_ticket_and_files"));
  assert.ok(claudeSkill.includes("Completion Gate"));
});

test("plugin MCP wrappers resolve back to the local Objective workspace", async () => {
  const codexServer = await readFile("plugins/codex/server.js", "utf8");
  const claudeServer = await readFile("plugins/claude/server.js", "utf8");
  assert.ok(codexServer.includes("OBJECTIVE_WORKSPACE_ROOT"));
  assert.ok(codexServer.includes("process.cwd()"));
  assert.ok(codexServer.includes("apps/mcp-server/server.js"));
  assert.equal(codexServer, claudeServer);
});
