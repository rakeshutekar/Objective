# Objective

> Local-first ticketing for AI agents. Built for Codex and Claude to plan work, claim files, run tests, attach proof, and mark tickets done while humans monitor progress in a Linear-style UI.

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-3c873a)](https://nodejs.org/)
[![Postgres](https://img.shields.io/badge/postgres-16-336791)](https://www.postgresql.org/)
[![MCP](https://img.shields.io/badge/MCP-agent_tools-111111)](https://modelcontextprotocol.io/)
[![Status](https://img.shields.io/badge/status-local_first-65d8ff)](#)

Objective is a work coordination layer for AI coding agents. Instead of using a human-first issue tracker, agents get purpose-built tools for creating tickets, claiming work, locking files, reporting test evidence, uploading proof artifacts, and completing work only after the required proof exists.

Humans get a local dashboard to see what every agent is doing.

## Why Objective Exists

AI agents need a shared source of truth for work. Human issue trackers are useful, but they are not designed around agent behavior:

- agents need explicit lease tokens before editing
- agents need file locks to avoid concurrent edits
- agents need machine-readable completion gates
- humans need proof, screenshots, test URLs, and status without reading every agent transcript
- multiple agents need to work against the same backlog without rate limits from an external SaaS

Objective is local-first and runs on your machine. Codex and Claude connect to the same backend through MCP.

## Features

- Project dashboard for human monitoring
- Linear-style ticket board
- Ticket creation, search, claim, update, block, reopen, and completion flows
- Required ticket fields: title, why, description, planned files, tests, proof URL, artifacts, final agent summary
- Lease-based ticket claiming
- File and glob-pattern locking
- Ticket dependencies with cycle prevention
- Completion gate that rejects `Done` until evidence exists
- Proof artifacts stored in object storage
- Append-only event history per ticket
- Agent heartbeat tracking
- Codex plugin package
- Claude plugin package
- Shared MCP server with agent-safe tools
- Local REST API and realtime SSE updates
- Postgres-backed state
- MinIO-backed object storage

## Product Preview

Objective has three main surfaces:

- **Dashboard**: live status, active work, proof review, service health
- **Board**: project tickets grouped by workflow status
- **Ticket detail**: why, description, files, tests, proof artifacts, completion checklist, event history

The local UI runs at:

```text
http://localhost:3000
```

## Architecture

```text
Codex plugin        Claude plugin
     |                   |
     |                   |
     +------- MCP -------+
             |
             v
      Objective MCP server
             |
             v
      Objective REST API
        |            |
        v            v
    Postgres       MinIO
        |
        v
  Human dashboard UI
```

## Repository Layout

```text
.
├── apps/
│   ├── mcp-server/        # MCP stdio server and tool definitions
│   └── web/               # Local REST API and vanilla web UI
├── packages/
│   ├── core/              # Ticket lifecycle, locking, completion rules
│   ├── db/                # Postgres client, migrations, seed data
│   ├── sdk/               # Small API client
│   └── storage/           # MinIO artifact storage
├── plugins/
│   ├── codex/             # Codex plugin package
│   └── claude/            # Claude plugin package
├── tests/
│   ├── e2e/               # Plugin-wrapper E2E tests
│   └── phase*.test.js     # Phase-level verification
├── docker-compose.yml
└── README.md
```

## Requirements

- Node.js 20 or newer
- Docker Desktop or Docker Engine
- Codex CLI, if you want to use the Codex plugin
- Claude Code, if you want to use the Claude plugin

## Quickstart

Install dependencies:

```bash
npm install
```

Start local services:

```bash
docker compose up -d
```

Run migrations and seed data:

```bash
npm run db:migrate
npm run db:seed
```

Start Objective:

```bash
npm run dev
```

Open the UI:

```text
http://localhost:3000
```

Health check:

```bash
curl -s http://localhost:3000/api/health
```

Expected response:

```json
{
  "ok": true,
  "service": "objective-web",
  "database": "ok",
  "storage": "ok"
}
```

## Agent Workflow

Objective expects agents to follow a strict workflow:

1. Read projects and available tickets.
2. Create a ticket if no ticket exists.
3. Claim the ticket and receive a lease token.
4. Claim the files or path patterns before editing.
5. Update the ticket with actual files changed.
6. Run tests and record the test result.
7. Attach proof artifacts, screenshots, or computer-use evidence.
8. Add a proof URL where a human can verify the result.
9. Submit the ticket as done.

Objective rejects completion unless the ticket has:

- tests performed
- proof screenshot or artifact
- proof/test URL
- final agent summary
- actual files changed

## MCP Tools

The MCP server exposes tools with the `objective_` prefix.

Core tools:

```text
objective_health
objective_tool_manifest
objective_agent_bootstrap
objective_create_agent
objective_list_projects
objective_create_project
objective_get_project
objective_list_project_tickets
objective_get_available_tickets
objective_search_tickets
objective_create_ticket
objective_get_ticket
```

Work tools:

```text
objective_claim_ticket
objective_renew_ticket_lease
objective_release_ticket
objective_update_ticket
objective_claim_files
objective_release_files
objective_get_file_claims
objective_record_test
objective_claim_ticket_and_files
objective_record_test_and_attach_log
```

Proof and completion tools:

```text
objective_attach_artifact
objective_attach_screenshot
objective_attach_proof
objective_validate_ticket_completion
objective_submit_done
objective_submit_done_with_artifacts
objective_mark_blocked
objective_reject_proof
objective_reopen_ticket
objective_archive_project
objective_archive_ticket
objective_cleanup_test_runs
objective_self_test
```

Coordination tools:

```text
objective_get_blockers
objective_add_dependency
objective_heartbeat
objective_keepalive
objective_list_agent_work
objective_get_ticket_events
```

## Running The MCP Server Directly

Objective exposes a local MCP server:

```bash
node apps/mcp-server/server.js
```

Default local API values:

```text
OBJECTIVE_API_BASE=http://127.0.0.1:3000
OBJECTIVE_AGENT_API_KEY=dev-agent-key
```

Smoke test:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n' \
  | OBJECTIVE_API_BASE=http://127.0.0.1:3000 \
    OBJECTIVE_AGENT_API_KEY=dev-agent-key \
    node apps/mcp-server/server.js
```

## Codex Plugin

Codex marketplace metadata lives at:

```text
.agents/plugins/marketplace.json
```

The Codex plugin package lives at:

```text
plugins/codex
```

Add the local marketplace:

```bash
codex plugin marketplace add "$(pwd)"
```

The Codex plugin starts the shared Objective MCP server through:

```text
plugins/codex/server.js
```

## Claude Plugin

Claude marketplace metadata lives at:

```text
.claude-plugin/marketplace.json
```

The Claude plugin package lives at:

```text
plugins/claude
```

Validate it:

```bash
claude plugin validate plugins/claude
```

Add and install it locally:

```bash
claude plugin marketplace add "$(pwd)" --scope local
claude plugin install objective@objective-local --scope local
```

The Claude plugin starts the shared Objective MCP server through:

```text
plugins/claude/server.js
```

## Configuration

Copy `.env.example` if you want to override local defaults:

```bash
cp .env.example .env
```

Common variables:

```text
OBJECTIVE_DATABASE_URL=postgres://objective:objective@localhost:5432/objective
OBJECTIVE_DATABASE_POOL_MAX=50
OBJECTIVE_DATABASE_LOCK_TIMEOUT_MS=5000
OBJECTIVE_DATABASE_STATEMENT_TIMEOUT_MS=30000
OBJECTIVE_API_BASE=http://127.0.0.1:3000
OBJECTIVE_AGENT_API_KEY=dev-agent-key
OBJECTIVE_ADMIN_TOKEN=dev-admin-token
OBJECTIVE_API_REQUEST_TIMEOUT_MS=10000
OBJECTIVE_HEALTH_CHECK_TIMEOUT_MS=1500
OBJECTIVE_DEFAULT_PAGE_SIZE=25
OBJECTIVE_MAX_PAGE_SIZE=200
OBJECTIVE_DEFAULT_LEASE_TTL_SECONDS=900
OBJECTIVE_MCP_PRETTY=false
OBJECTIVE_STORAGE_ENDPOINT=localhost
OBJECTIVE_STORAGE_PORT=9000
OBJECTIVE_STORAGE_ACCESS_KEY=objective
OBJECTIVE_STORAGE_SECRET_KEY=objective-secret
OBJECTIVE_STORAGE_BUCKET=objective-artifacts
```

## Development

Run the app:

```bash
npm run dev
```

Run migrations:

```bash
npm run db:migrate
```

Seed local data:

```bash
npm run db:seed
```

Run all tests:

```bash
npm test
```

Run plugin E2E tests:

```bash
npm run test:e2e
```

## Test Coverage

The current test suite verifies:

- web health endpoint
- schema creation and dependency-cycle rejection
- ticket lifecycle and lease enforcement
- stale lease rejection
- path overlap detection
- file lock conflict and release behavior
- dependency blockers
- MinIO proof artifact storage
- REST API workflow
- MCP tool workflow
- Codex and Claude plugin manifests
- UI asset serving and board structure
- realtime SSE snapshots
- search, proof rejection, reopen flows
- 1000 local agent heartbeats
- full MCP completion workflow
- bounded MCP project and event responses
- validation and actionable agent errors
- bootstrap and manifest tools
- artifact URL proof defaults
- composed workflow tools
- self-test and archive cleanup
- Codex and Claude plugin wrapper E2E completion

Current local verification:

```text
31 tests passing
```

## Completion Gate

Objective is intentionally strict. A ticket cannot move to `Done` unless the agent provides real completion evidence.

Required evidence:

| Requirement | Purpose |
| --- | --- |
| Tests performed | Confirms the agent verified its work |
| Proof artifact | Gives humans concrete evidence |
| Proof URL | Lets humans inspect the running result |
| Final agent summary | Captures what changed |
| Actual files changed | Creates an execution record |

If any requirement is missing, Objective moves the ticket to `Verification Failed` and records an event.

## Performance And Token Defaults

Objective keeps agent tool calls bounded and compact by default:

- MCP responses use compact JSON unless `OBJECTIVE_MCP_PRETTY=true`.
- List tools return compact bounded pages by default and accept `limit`, `cursor`, `q`, `createdAfter`, and `includeArchived`.
- Database lock waits fail fast after `OBJECTIVE_DATABASE_LOCK_TIMEOUT_MS` so agents retry instead of hanging on a blocked ticket.
- Database statements are bounded by `OBJECTIVE_DATABASE_STATEMENT_TIMEOUT_MS`.
- Agent API requests time out after `OBJECTIVE_API_REQUEST_TIMEOUT_MS`.
- Health checks run database and storage checks in parallel with `OBJECTIVE_HEALTH_CHECK_TIMEOUT_MS`.
- `objective_get_ticket_events` returns the latest 25 compact events by default; pass `includeData: true` for full event data.
- `objective_agent_bootstrap` returns compact runtime/plugin status; use `objective_tool_manifest` when an agent needs the full tool schema.
- Composed workflow tools should be preferred over manual primitive-call stitching.

These defaults reduce tool latency and token usage while keeping the full structured payload available to agents.

## Status Model

Tickets move through these statuses:

```text
Ready
Claimed
In Progress
Blocked
Proof Submitted
Verification Failed
Reopened
Done
Canceled
```

## File Locking

Agents claim files or glob patterns before editing:

```text
apps/web/**
packages/core/lifecycle.js
README.md
```

Objective rejects overlapping active claims. Done and canceled tickets release active claims so other agents can continue.

## Local-First By Design

Objective is currently built for local development:

- no hosted dependency
- no external SaaS dependency
- no external rate limits
- shared local Postgres backend
- shared local object storage
- multiple local agents can connect to the same API

This makes it useful for agent-heavy development on one machine. A future hosted version can keep the same MCP tool contract.

## Open Source Readiness

Objective is ready to publish under the MIT License. Before creating the public GitHub repository, update the repository URL wherever you want permanent links, badges, or package metadata.

The source license is declared consistently in:

- `LICENSE`
- `package.json`
- `plugins/codex/.codex-plugin/plugin.json`
- `plugins/claude/.claude-plugin/plugin.json`

## Roadmap

- Hosted deployment profile
- Multi-user authentication
- Project-level API keys
- Webhook/event sink support
- Better artifact previews in the UI
- Agent identity management
- Workspace-scoped settings UI
- Import/export of ticket history
- Git branch and PR metadata fields
- Richer computer-use proof viewer

## Contributing

Contributions are welcome once the public repository is created.

Suggested contribution flow:

1. Open an issue or Objective ticket describing the change.
2. Claim the files you plan to edit.
3. Add or update tests.
4. Attach proof for UI or workflow changes.
5. Open a pull request with the test command and proof URL.

## Security

Objective is local-first, but it still handles agent-write workflows. Treat API keys and proof artifacts as sensitive in shared environments.

Do not expose the local API publicly without adding authentication, authorization, and transport security.

## License

Objective is released under the [MIT License](LICENSE).
