export function env(name, fallback = undefined) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value;
}

export function intEnv(name, fallback) {
  const value = env(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

export const config = {
  port: intEnv("OBJECTIVE_PORT", 3000),
  apiBase: env("OBJECTIVE_API_BASE", "http://127.0.0.1:3000"),
  version: env("OBJECTIVE_VERSION", "0.2.0"),
  schemaVersion: env("OBJECTIVE_SCHEMA_VERSION", "002_agent_ergonomics"),
  databaseUrl: env(
    "OBJECTIVE_DATABASE_URL",
    "postgres://objective:objective@localhost:5432/objective",
  ),
  databasePoolMax: intEnv("OBJECTIVE_DATABASE_POOL_MAX", 50),
  databaseLockTimeoutMs: intEnv("OBJECTIVE_DATABASE_LOCK_TIMEOUT_MS", 5_000),
  databaseStatementTimeoutMs: intEnv("OBJECTIVE_DATABASE_STATEMENT_TIMEOUT_MS", 30_000),
  agentApiKey: env("OBJECTIVE_AGENT_API_KEY", "dev-agent-key"),
  adminToken: env("OBJECTIVE_ADMIN_TOKEN", "dev-admin-token"),
  apiRequestTimeoutMs: intEnv("OBJECTIVE_API_REQUEST_TIMEOUT_MS", 10_000),
  healthCheckTimeoutMs: intEnv("OBJECTIVE_HEALTH_CHECK_TIMEOUT_MS", 1_500),
  defaultPageSize: intEnv("OBJECTIVE_DEFAULT_PAGE_SIZE", 25),
  maxPageSize: intEnv("OBJECTIVE_MAX_PAGE_SIZE", 200),
  leaseTtlSeconds: intEnv(
    "OBJECTIVE_LEASE_TTL_SECONDS",
    intEnv("OBJECTIVE_DEFAULT_LEASE_TTL_SECONDS", 900),
  ),
  artifactMaxBytes: intEnv("OBJECTIVE_ARTIFACT_MAX_BYTES", 10 * 1024 * 1024),
  storage: {
    endpoint: env("OBJECTIVE_STORAGE_ENDPOINT", "localhost"),
    port: intEnv("OBJECTIVE_STORAGE_PORT", 9000),
    useSSL: env("OBJECTIVE_STORAGE_USE_SSL", "false") === "true",
    accessKey: env("OBJECTIVE_STORAGE_ACCESS_KEY", "objective"),
    secretKey: env("OBJECTIVE_STORAGE_SECRET_KEY", "objective-secret"),
    bucket: env("OBJECTIVE_STORAGE_BUCKET", "objective-artifacts"),
  },
};
