CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_status') THEN
    CREATE TYPE ticket_status AS ENUM (
      'Draft',
      'Ready',
      'Claimed',
      'In Progress',
      'Blocked',
      'Proof Submitted',
      'Verification Failed',
      'Done',
      'Canceled',
      'Reopened'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_kind') THEN
    CREATE TYPE agent_kind AS ENUM ('codex', 'claude', 'human', 'system', 'unknown');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'artifact_type') THEN
    CREATE TYPE artifact_type AS ENUM (
      'screenshot',
      'computer-use-screenshot',
      'browser-screenshot',
      'test-log',
      'json-proof',
      'text-proof',
      'other-file'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind agent_kind NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
  label text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  why text NOT NULL,
  description text NOT NULL,
  status ticket_status NOT NULL DEFAULT 'Draft',
  planned_files text[] NOT NULL DEFAULT '{}',
  actual_files_changed text[] NOT NULL DEFAULT '{}',
  test_plan text NOT NULL DEFAULT '',
  tests_performed text[] NOT NULL DEFAULT '{}',
  computer_use_required boolean NOT NULL DEFAULT false,
  proof_screenshot_id uuid,
  proof_url text NOT NULL DEFAULT '',
  final_agent_summary text NOT NULL DEFAULT '',
  assigned_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  lease_token text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz
);

CREATE TABLE IF NOT EXISTS ticket_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  message text NOT NULL DEFAULT '',
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  depends_on_ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, depends_on_ticket_id),
  CHECK (ticket_id <> depends_on_ticket_id)
);

CREATE TABLE IF NOT EXISTS ticket_file_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  path_pattern text NOT NULL,
  normalized_pattern text NOT NULL,
  lease_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE TABLE IF NOT EXISTS agent_heartbeats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id uuid REFERENCES agent_sessions(id) ON DELETE CASCADE,
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS test_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  command text NOT NULL,
  status text NOT NULL,
  output text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS artifact_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_key text NOT NULL UNIQUE,
  filename text NOT NULL,
  mime_type text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint NOT NULL DEFAULT 0,
  checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proof_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  artifact_object_id uuid NOT NULL REFERENCES artifact_objects(id) ON DELETE CASCADE,
  type artifact_type NOT NULL,
  label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tickets
  DROP CONSTRAINT IF EXISTS tickets_proof_screenshot_id_fkey,
  ADD CONSTRAINT tickets_proof_screenshot_id_fkey
    FOREIGN KEY (proof_screenshot_id) REFERENCES proof_artifacts(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_tickets_project_status ON tickets(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_agent ON tickets(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_created ON ticket_events(ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ticket_file_claims_active
  ON ticket_file_claims(normalized_pattern, expires_at)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_agent_seen ON agent_heartbeats(agent_id, seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_proof_artifacts_ticket ON proof_artifacts(ticket_id, created_at DESC);

CREATE OR REPLACE FUNCTION objective_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_touch_updated_at ON projects;
CREATE TRIGGER projects_touch_updated_at
BEFORE UPDATE ON projects
FOR EACH ROW EXECUTE FUNCTION objective_touch_updated_at();

DROP TRIGGER IF EXISTS tickets_touch_updated_at ON tickets;
CREATE TRIGGER tickets_touch_updated_at
BEFORE UPDATE ON tickets
FOR EACH ROW EXECUTE FUNCTION objective_touch_updated_at();

CREATE OR REPLACE FUNCTION objective_reject_dependency_cycles()
RETURNS trigger AS $$
BEGIN
  IF NEW.ticket_id = NEW.depends_on_ticket_id THEN
    RAISE EXCEPTION 'ticket cannot depend on itself';
  END IF;

  IF EXISTS (
    WITH RECURSIVE dependency_tree(ticket_id, depends_on_ticket_id) AS (
      SELECT ticket_id, depends_on_ticket_id
      FROM ticket_dependencies
      WHERE ticket_id = NEW.depends_on_ticket_id
      UNION
      SELECT td.ticket_id, td.depends_on_ticket_id
      FROM ticket_dependencies td
      JOIN dependency_tree dt ON td.ticket_id = dt.depends_on_ticket_id
    )
    SELECT 1
    FROM dependency_tree
    WHERE depends_on_ticket_id = NEW.ticket_id
  ) THEN
    RAISE EXCEPTION 'ticket dependency cycle detected';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ticket_dependencies_reject_cycles ON ticket_dependencies;
CREATE TRIGGER ticket_dependencies_reject_cycles
BEFORE INSERT OR UPDATE ON ticket_dependencies
FOR EACH ROW EXECUTE FUNCTION objective_reject_dependency_cycles();
