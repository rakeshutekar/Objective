import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = path.resolve(moduleDir, "../..");

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

export function pluginPathStatus({ workspaceRoot = defaultWorkspaceRoot, pluginKind = "codex" } = {}) {
  const pluginRoot =
    pluginKind === "claude"
      ? path.join(workspaceRoot, "plugins", "claude")
      : path.join(workspaceRoot, "plugins", "codex");
  const sourceManifestPath =
    pluginKind === "claude"
      ? path.join(pluginRoot, ".claude-plugin", "plugin.json")
      : path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const sourceSkillPath = path.join(pluginRoot, "skills", "objective", "SKILL.md");
  const cacheRoot =
    pluginKind === "claude"
      ? path.join(os.homedir(), ".claude", "plugins", "cache", "objective-local", "objective", config.version)
      : path.join(os.homedir(), ".codex", "plugins", "cache", "objective-local", "objective", config.version);
  const cachedManifestPath =
    pluginKind === "claude"
      ? path.join(cacheRoot, ".claude-plugin", "plugin.json")
      : path.join(cacheRoot, ".codex-plugin", "plugin.json");
  const cachedSkillPath = path.join(cacheRoot, "skills", "objective", "SKILL.md");
  const effectiveManifestPath = existingPath(sourceManifestPath, cachedManifestPath);
  const effectiveSkillPath = existingPath(cachedSkillPath, sourceSkillPath);

  return {
    pluginKind,
    manifestPath: effectiveManifestPath ?? sourceManifestPath,
    manifestExists: Boolean(effectiveManifestPath),
    sourceManifestPath,
    sourceManifestExists: existsSync(sourceManifestPath),
    cachedManifestPath,
    cachedManifestExists: existsSync(cachedManifestPath),
    effectiveManifestPath,
    skillPath: effectiveSkillPath ?? sourceSkillPath,
    skillExists: Boolean(effectiveSkillPath),
    sourceSkillPath,
    sourceSkillExists: existsSync(sourceSkillPath),
    cachedSkillPath,
    cachedSkillExists: existsSync(cachedSkillPath),
    effectiveSkillPath,
    manifest: readJson(effectiveManifestPath),
  };
}

export function toolManifest({ tools = [], workspaceRoot = defaultWorkspaceRoot, pluginKind = "codex" } = {}) {
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
