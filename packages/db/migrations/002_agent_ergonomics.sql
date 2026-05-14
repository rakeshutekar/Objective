ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retention_expires_at timestamptz;

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retention_expires_at timestamptz;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS external_key text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_external_key
  ON agents(external_key)
  WHERE external_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_projects_active_updated
  ON projects(archived_at, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_projects_created
  ON projects(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_tickets_project_active_updated
  ON tickets(project_id, archived_at, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_tickets_created
  ON tickets(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_created_id
  ON ticket_events(ticket_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_file_claims_ticket_created
  ON ticket_file_claims(ticket_id, created_at DESC, id DESC);
