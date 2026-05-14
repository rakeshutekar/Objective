import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginDir = path.dirname(fileURLToPath(import.meta.url));

function inferMarketplaceName() {
  const parts = pluginDir.split(path.sep);
  const cacheIndex = parts.lastIndexOf("cache");
  return cacheIndex >= 0 ? parts[cacheIndex + 1] : null;
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readCodexMarketplaceSource(name) {
  if (!name) return null;
  try {
    const configPath = path.join(os.homedir(), ".codex", "config.toml");
    const config = readFileSync(configPath, "utf8");
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = config.match(new RegExp(`\\[marketplaces\\.(?:"${escaped}"|${escaped})\\]([\\s\\S]*?)(?=\\n\\[|$)`));
    return match?.[1]?.match(/source\s*=\s*"([^"]+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function readClaudeMarketplaceSource(name) {
  if (!name) return null;
  const known = readJson(path.join(os.homedir(), ".claude", "plugins", "known_marketplaces.json"));
  const entry = known?.[name];
  return entry?.source?.path ?? entry?.installLocation ?? null;
}

const marketplaceName = inferMarketplaceName();
const candidates = [
  process.env.OBJECTIVE_WORKSPACE_ROOT,
  process.cwd(),
  readCodexMarketplaceSource(marketplaceName),
  readClaudeMarketplaceSource(marketplaceName),
  path.resolve(pluginDir, "../.."),
  path.resolve(pluginDir, "../../.."),
].filter(Boolean);

function resolveServerPath() {
  for (const candidate of candidates) {
    const serverPath = path.resolve(candidate, "apps/mcp-server/server.js");
    if (existsSync(serverPath)) return serverPath;
  }
  console.error(
    "Could not find apps/mcp-server/server.js. Run the plugin from the Objective workspace or set OBJECTIVE_WORKSPACE_ROOT.",
  );
  process.exit(1);
}

const serverPath = resolveServerPath();

await import(pathToFileURL(serverPath).href).catch((error) => {
  console.error(error);
  process.exit(1);
});
