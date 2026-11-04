/**
 * SOC 2 compliance domain schema (F1-002 — AWS Read-Only Config Connector).
 *
 * Carve-out tables for the SOC 2 product. Every row is organization_id-scoped
 * (multi-tenant via @nexus/organizations-and-teams). The AWS connector stores
 * NO long-lived customer credentials: only a per-org ExternalId + the customer
 * role ARN that trusts the Nexus anchor account (STS AssumeRole at collect
 * time). Snapshot JSON is persisted ONLY after a redaction pass.
 *
 * Picked up by packages/db/migrate.ts via the `*_DDL` constant convention and
 * executed (idempotently) against the company DB before `next build`.
 *
 * Lego-owned tables referenced by this domain but created elsewhere:
 *   - organizations, org_members  → legos/organizations-and-teams/schema
 * (do NOT redeclare them here).
 */

export const SOC2_DDL = `
-- ─────────────────────────────────────────────────────────────────────────
-- soc2_connections — one AWS read-only connection per org (may be re-created).
-- Holds the trust-anchor wiring only: role ARN + per-org ExternalId. No keys.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS soc2_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  provider         text NOT NULL DEFAULT 'aws',
  aws_account_id   text,
  role_arn         text,
  external_id      text NOT NULL,
  region           text NOT NULL DEFAULT 'us-east-1',
  status           text NOT NULL DEFAULT 'pending',
  trust_verified   boolean NOT NULL DEFAULT false,
  last_error       text,
  last_verified_at timestamptz,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_connections_org
  ON soc2_connections (organization_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- soc2_config_snapshots — versioned, per-connection snapshot of AWS config.
-- raw_redacted holds the collected service data AFTER redaction. A snapshot is
-- "partial" when one or more collectors failed soft.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS soc2_config_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  connection_id       uuid NOT NULL,
  version             integer NOT NULL DEFAULT 1,
  status              text NOT NULL DEFAULT 'pending',
  partial             boolean NOT NULL DEFAULT false,
  services_total      integer NOT NULL DEFAULT 0,
  services_completed  integer NOT NULL DEFAULT 0,
  services_failed     integer NOT NULL DEFAULT 0,
  findings_count      integer NOT NULL DEFAULT 0,
  raw_redacted        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error               text,
  started_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_snapshots_conn
  ON soc2_config_snapshots (connection_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_soc2_snapshots_org
  ON soc2_config_snapshots (organization_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- soc2_snapshot_findings — normalized observations (one row per check result).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS soc2_snapshot_findings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  snapshot_id      uuid NOT NULL,
  service          text NOT NULL,
  check_id         text NOT NULL,
  resource_id      text,
  resource_arn     text,
  severity         text NOT NULL DEFAULT 'info',
  status           text NOT NULL DEFAULT 'pass',
  title            text NOT NULL,
  detail           text,
  raw              jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_findings_snapshot
  ON soc2_snapshot_findings (snapshot_id, service);
CREATE INDEX IF NOT EXISTS idx_soc2_findings_org
  ON soc2_snapshot_findings (organization_id, severity);

-- ─────────────────────────────────────────────────────────────────────────
-- soc2_snapshot_jobs — chunked collection queue. The minute-level cron runner
-- (api/cron/soc2-job-runner) claims queued rows one chunk per invocation so a
-- multi-service collection never exceeds the Vercel function duration limit.
-- failing_action records the exact IAM action/permission a collector tripped on.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS soc2_snapshot_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  connection_id    uuid NOT NULL,
  snapshot_id      uuid NOT NULL,
  service          text NOT NULL,
  state            text NOT NULL DEFAULT 'queued',
  attempts         integer NOT NULL DEFAULT 0,
  findings_count   integer NOT NULL DEFAULT 0,
  failing_action   text,
  last_error       text,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_jobs_runner
  ON soc2_snapshot_jobs (state, created_at);
CREATE INDEX IF NOT EXISTS idx_soc2_jobs_snapshot
  ON soc2_snapshot_jobs (snapshot_id, state);
`;
