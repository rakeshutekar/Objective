import { config } from "../core/config.js";

export class ObjectiveClient {
  constructor({ apiBase = config.apiBase, apiKey = config.agentApiKey } = {}) {
    this.apiBase = apiBase.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  async request(method, path, body = undefined) {
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json();
    if (!response.ok) {
      const err = new Error(payload.message || "Objective API request failed.");
      err.status = response.status;
      err.payload = payload;
      throw err;
    }
    return payload;
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
