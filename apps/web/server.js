import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../packages/core/config.js";
import { handleApi } from "./api.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    });
    res.end(body);
  } catch {
    json(res, 404, { error: "not_found", message: "File not found" });
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    if (req.url?.startsWith("/api/")) {
      const handled = await handleApi(req, res);
      if (!handled) json(res, 404, { error: "not_found", message: "API route not found" });
      return;
    }

    await serveStatic(req, res);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(config.port, () => {
    console.log(`Objective UI/API listening on http://localhost:${config.port}`);
  });
}
