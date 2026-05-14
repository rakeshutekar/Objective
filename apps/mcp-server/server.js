import { config } from "../../packages/core/config.js";
import { createTools, publicToolDefinitions } from "./tools.js";

const tools = createTools();
const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
const prettyResponses = process.env.OBJECTIVE_MCP_PRETTY === "true";

function toolText(payload) {
  return JSON.stringify(payload, null, prettyResponses ? 2 : 0);
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, payload) {
  write({ jsonrpc: "2.0", id, result: payload });
}

function error(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(request) {
  if (request.method === "initialize") {
    result(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "objective", version: "0.1.3" },
    });
    return;
  }

  if (request.method === "tools/list") {
    result(request.id, { tools: publicToolDefinitions(tools) });
    return;
  }

  if (request.method === "tools/call") {
    const name = request.params?.name;
    const selected = toolMap.get(name);
    if (selected) {
      try {
        const payload = await selected.handler(request.params?.arguments ?? {});
        result(request.id, {
          content: [
            {
              type: "text",
              text: toolText(payload),
            },
          ],
        });
      } catch (err) {
        result(request.id, {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: err.payload?.error ?? err.code ?? "objective_tool_error",
                  message: err.payload?.message ?? err.message,
                  details: err.payload?.details,
                },
                null,
                prettyResponses ? 2 : 0,
              ),
            },
          ],
        });
      }
      return;
    }

    if (name === "objective_mcp_health") {
      result(request.id, {
        content: [
          {
            type: "text",
            text: toolText({
              ok: true,
              service: "objective-mcp",
              apiBase: config.apiBase,
            }),
          },
        ],
      });
      return;
    }
    error(request.id, -32601, `Unknown tool: ${name}`);
    return;
  }

  if (request.id !== undefined) {
    error(request.id, -32601, `Unknown method: ${request.method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      await handle(JSON.parse(line));
    } catch (err) {
      error(null, -32700, err.message);
    }
  }
});
