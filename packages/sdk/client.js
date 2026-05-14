import { config } from "../core/config.js";

export class ObjectiveClient {
  constructor({ apiBase = config.apiBase, apiKey = config.agentApiKey } = {}) {
    this.apiBase = apiBase.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  async request(method, path, body = undefined) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.apiRequestTimeoutMs);
    try {
      const response = await fetch(`${this.apiBase}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }).catch((err) => {
        if (err.name === "AbortError") {
          const timeout = new Error(`Objective API request timed out after ${config.apiRequestTimeoutMs}ms.`);
          timeout.code = "objective_api_timeout";
          throw timeout;
        }
        throw err;
      });
      const payload = await response.json();
      if (!response.ok) {
        const err = new Error(payload.message || "Objective API request failed.");
        err.status = response.status;
        err.payload = payload;
        throw err;
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  get(path) {
    return this.request("GET", path);
  }

  post(path, body) {
    return this.request("POST", path, body);
  }

  patch(path, body) {
    return this.request("PATCH", path, body);
  }
}
