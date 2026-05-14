import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.env.OBJECTIVE_WORKSPACE_ROOT,
  process.cwd(),
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
