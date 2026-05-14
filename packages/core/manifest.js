import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function existingPath(...candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

export function pluginPathStatus({ workspaceRoot = process.cwd(), pluginKind = "codex" } = {}) {
  const pluginRoot =
    pluginKind === "claude"
      ? path.join(workspaceRoot, "plugins", "claude")
      : path.join(workspaceRoot, "plugins", "codex");
  const manifestPath =
    pluginKind === "claude"
      ? path.join(pluginRoot, ".claude-plugin", "plugin.json")
      : path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const skillPath = path.join(pluginRoot, "skills", "objective", "SKILL.md");
  const cacheRoot =
    pluginKind === "claude"
      ? path.join(os.homedir(), ".claude", "plugins", "cache", "objective-local", "objective", config.version)
      : path.join(os.homedir(), ".codex", "plugins", "cache", "objective-local", "objective", config.version);
  const cachedSkillPath = path.join(cacheRoot, "skills", "objective", "SKILL.md");

  return {
    pluginKind,
    manifestPath,
    manifestExists: existsSync(manifestPath),
    skillPath,
    skillExists: existsSync(skillPath),
    cachedSkillPath,
    cachedSkillExists: existsSync(cachedSkillPath),
    effectiveSkillPath: existingPath(cachedSkillPath, skillPath),
    manifest: readJson(manifestPath),
  };
}

export function toolManifest({ tools = [], workspaceRoot = process.cwd(), pluginKind = "codex" } = {}) {
  return {
    apiVersion: config.version,
    mcpVersion: config.version,
    schemaVersion: config.schemaVersion,
    apiBase: config.apiBase,
    responseModes: ["summary", "full"],
    defaults: {
      pageSize: config.defaultPageSize,
      maxPageSize: config.maxPageSize,
      leaseTtlSeconds: config.leaseTtlSeconds,
    },
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    plugin: pluginPathStatus({ workspaceRoot, pluginKind }),
  };
}
