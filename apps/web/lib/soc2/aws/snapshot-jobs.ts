/**
 * Snapshot + chunked-job data access for the AWS connector (F1-002).
 *
 * All persistence for soc2_connections / soc2_config_snapshots /
 * soc2_snapshot_findings / soc2_snapshot_jobs lives here, behind parameterized
 * raw SQL (same externalized `pg` pattern as lib/db.ts and lib/blog.ts). Every
 * query is organization_id-scoped. Snapshot JSON is redacted before it is
 * written. The job runner (api/cron/soc2-job-runner) drives collection one
 * chunk at a time via runJobChunk().
 */

import { randomUUID } from "crypto";
import {
  assumeRole,
  deriveExternalId,
  type ConnectionTrust,
  type TrustVerification,
} from "./assume-role";
import {
  runCollector,
  SERVICE_ORDER,
  type CollectorResult,
  type Finding,
} from "./collectors";
import { redactSnapshot, redactValue } from "./redact";

// ── pool (externalized pg; created at first call so preview builds compile) ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pool: any = null;

function getPool(): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
} {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (config: Record<string, unknown>) => {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    };
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const { rows } = await getPool().query(sql, params);
  return rows as T[];
}

// ── row shapes ──────────────────────────────────────────────────────────────

export interface Soc2Connection {
  id: string;
  organization_id: string;
  provider: string;
  aws_account_id: string | null;
  role_arn: string | null;
  external_id: string;
  region: string;
  status: string;
  trust_verified: boolean;
  last_error: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Soc2Snapshot {
  id: string;
  organization_id: string;
  connection_id: string;
  version: number;
  status: string;
  partial: boolean;
  services_total: number;
  services_completed: number;
  services_failed: number;
  findings_count: number;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface Soc2Job {
  id: string;
  organization_id: string;
  connection_id: string;
  snapshot_id: string;
  service: string;
  state: string;
  attempts: number;
  findings_count: number;
  failing_action: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface Soc2Finding {
  id: string;
  snapshot_id: string;
  service: string;
  check_id: string;
  resource_id: string | null;
  resource_arn: string | null;
  severity: string;
  status: string;
  title: string;
  detail: string | null;
  observed_at: string;
}

// ── org resolution ──────────────────────────────────────────────────────────

export interface ActiveOrg {
  id: string;
  name: string;
  role: string;
}

/**
 * Resolve the current user's active organization + their role in it. Prefers an
 * owner/admin membership (the CTO connecting AWS), then any membership. Returns
 * null if the user belongs to no org yet. Lego-owned tables (organizations,
 * org_members) are queried read-only here.
 */
export async function getActiveOrg(userId: string): Promise<ActiveOrg | null> {
  if (!userId) return null;
  const rows = await query<{ id: string; name: string; role: string }>(
    `SELECT o.id, o.name, m.role
       FROM org_members m
       JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
                           WHEN 'member' THEN 2 ELSE 3 END,
               m.joined_at ASC
      LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

/** True if the role may mutate connections / trigger snapshots (CTO = owner/admin). */
export function canManageConnections(role: string): boolean {
  return role === "owner" || role === "admin";
}

// ── connections ───────────────────────────────────────────────────────────

/**
 * Return the org's most recent AWS connection, or null. (One active connection
 * per org is the norm, but re-connecting creates a new row.)
 */
export async function getConnectionForOrg(orgId: string): Promise<Soc2Connection | null> {
  const rows = await query<Soc2Connection>(
    `SELECT * FROM soc2_connections
      WHERE organization_id = $1 AND provider = 'aws'
      ORDER BY created_at DESC
      LIMIT 1`,
    [orgId],
  );
  return rows[0] ?? null;
}

export async function getConnectionById(
  orgId: string,
  connectionId: string,
): Promise<Soc2Connection | null> {
  const rows = await query<Soc2Connection>(
    `SELECT * FROM soc2_connections WHERE id = $1 AND organization_id = $2 LIMIT 1`,
    [connectionId, orgId],
  );
  return rows[0] ?? null;
}

/**
 * Create (or return the existing) AWS connection for an org. Idempotent on the
 * org: if a pending/verified connection already exists we reuse it so the
 * ExternalId stays stable across stepper visits.
 */
export async function ensureConnection(params: {
  orgId: string;
  userId: string;
  region?: string;
}): Promise<Soc2Connection> {
  const existing = await getConnectionForOrg(params.orgId);
  if (existing) return existing;

  const externalId = deriveExternalId(params.orgId);
  const id = randomUUID();
  const rows = await query<Soc2Connection>(
    `INSERT INTO soc2_connections (id, organization_id, external_id, region, status, created_by)
     VALUES ($1, $2, $3, $4, 'pending', $5)
     RETURNING *`,
    [id, params.orgId, externalId, params.region || "us-east-1", params.userId || null],
  );
  return rows[0];
}

/**
 * Persist the role ARN the customer finished provisioning + optional account id.
 */
export async function setConnectionRole(params: {
  orgId: string;
  connectionId: string;
  roleArn: string;
  awsAccountId?: string | null;
  region?: string;
}): Promise<Soc2Connection | null> {
  const rows = await query<Soc2Connection>(
    `UPDATE soc2_connections
        SET role_arn = $3,
            aws_account_id = COALESCE($4, aws_account_id),
            region = COALESCE($5, region),
            updated_at = now()
      WHERE id = $1 AND organization_id = $2
      RETURNING *`,
    [params.connectionId, params.orgId, params.roleArn, params.awsAccountId ?? null, params.region ?? null],
  );
  return rows[0] ?? null;
}

/** Record the outcome of a trust-verification attempt. */
export async function recordTrustVerification(params: {
  orgId: string;
  connectionId: string;
  result: TrustVerification;
}): Promise<void> {
  const { result } = params;
  await query(
    `UPDATE soc2_connections
        SET trust_verified = $3,
            status = $4,
            aws_account_id = COALESCE($5, aws_account_id),
            last_error = $6,
            last_verified_at = CASE WHEN $3 THEN now() ELSE last_verified_at END,
            updated_at = now()
      WHERE id = $1 AND organization_id = $2`,
    [
      params.connectionId,
      params.orgId,
      result.ok,
      result.ok ? "verified" : "failed",
      result.accountId ?? null,
      result.ok ? null : `${result.failingAction ?? "sts:AssumeRole"}: ${result.error ?? "verification failed"}`,
    ],
  );
}

// ── snapshots + jobs ──────────────────────────────────────────────────────

/**
 * Create a new versioned snapshot for a connection and enqueue one job per
 * collector. Returns the snapshot id. The cron runner performs the actual work.
 */
export async function createSnapshot(params: {
  orgId: string;
  connectionId: string;
}): Promise<string> {
  const verRows = await query<{ next: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next
       FROM soc2_config_snapshots WHERE connection_id = $1`,
    [params.connectionId],
  );
  const version = Number(verRows[0]?.next ?? 1);
  const snapshotId = randomUUID();

  await query(
    `INSERT INTO soc2_config_snapshots
       (id, organization_id, connection_id, version, status, services_total, started_at)
     VALUES ($1, $2, $3, $4, 'running', $5, now())`,
    [snapshotId, params.orgId, params.connectionId, version, SERVICE_ORDER.length],
  );

  for (const service of SERVICE_ORDER) {
    await query(
      `INSERT INTO soc2_snapshot_jobs
         (id, organization_id, connection_id, snapshot_id, service, state)
       VALUES ($1, $2, $3, $4, $5, 'queued')`,
      [randomUUID(), params.orgId, params.connectionId, snapshotId, service],
    );
  }

  return snapshotId;
}

export async function getSnapshotById(
  orgId: string,
  snapshotId: string,
): Promise<Soc2Snapshot | null> {
  const rows = await query<Soc2Snapshot>(
    `SELECT * FROM soc2_config_snapshots WHERE id = $1 AND organization_id = $2 LIMIT 1`,
    [snapshotId, orgId],
  );
  return rows[0] ?? null;
}

export async function getLatestSnapshot(
  orgId: string,
  connectionId: string,
): Promise<Soc2Snapshot | null> {
  const rows = await query<Soc2Snapshot>(
    `SELECT * FROM soc2_config_snapshots
      WHERE connection_id = $1 AND organization_id = $2
      ORDER BY version DESC LIMIT 1`,
    [connectionId, orgId],
  );
  return rows[0] ?? null;
}

export async function listSnapshots(
  orgId: string,
  connectionId: string,
  limit = 20,
): Promise<Soc2Snapshot[]> {
  return query<Soc2Snapshot>(
    `SELECT * FROM soc2_config_snapshots
      WHERE connection_id = $1 AND organization_id = $2
      ORDER BY version DESC LIMIT $3`,
    [connectionId, orgId, limit],
  );
}

/** Per-service job rows for a snapshot (drives the live progress UI). */
export async function getSnapshotJobs(
  orgId: string,
  snapshotId: string,
): Promise<Soc2Job[]> {
  return query<Soc2Job>(
    `SELECT * FROM soc2_snapshot_jobs
      WHERE snapshot_id = $1 AND organization_id = $2
      ORDER BY created_at ASC`,
    [snapshotId, orgId],
  );
}

export async function getFindings(
  orgId: string,
  snapshotId: string,
): Promise<Soc2Finding[]> {
  return query<Soc2Finding>(
    `SELECT id, snapshot_id, service, check_id, resource_id, resource_arn,
            severity, status, title, detail, observed_at
       FROM soc2_snapshot_findings
      WHERE snapshot_id = $1 AND organization_id = $2
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
                      WHEN 'low' THEN 3 ELSE 4 END,
        service ASC`,
    [snapshotId, orgId],
  );
}

// ── job runner (invoked by the cron chunk processor) ────────────────────────

interface ClaimedJob extends Soc2Job {
  role_arn: string | null;
  external_id: string;
  region: string;
  aws_account_id: string | null;
}

/**
 * Atomically claim up to `limit` queued jobs (FOR UPDATE SKIP LOCKED) and mark
 * them running, joining the connection trust needed to assume the role.
 */
async function claimJobs(limit: number): Promise<ClaimedJob[]> {
  return query<ClaimedJob>(
    `WITH claimed AS (
       SELECT j.id
         FROM soc2_snapshot_jobs j
        WHERE j.state = 'queued'
        ORDER BY j.created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE soc2_snapshot_jobs j
        SET state = 'running', attempts = j.attempts + 1, started_at = now(), updated_at = now()
       FROM claimed c
       JOIN soc2_connections conn ON conn.id = j.connection_id
      WHERE j.id = c.id
      RETURNING j.*, conn.role_arn, conn.external_id, conn.region, conn.aws_account_id`,
    [limit],
  );
}

/** Persist normalized findings for a job (redacting each finding's raw blob). */
async function persistFindings(
  job: ClaimedJob,
  findings: Finding[],
): Promise<void> {
  for (const f of findings) {
    const redactedRaw = redactValue(f.raw ?? {}) as Record<string, unknown>;
    await query(
      `INSERT INTO soc2_snapshot_findings
         (id, organization_id, snapshot_id, service, check_id, resource_id, resource_arn,
          severity, status, title, detail, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        randomUUID(),
        job.organization_id,
        job.snapshot_id,
        f.service,
        f.checkId,
        f.resourceId ?? null,
        f.resourceArn ?? null,
        f.severity,
        f.status,
        f.title,
        f.detail ?? null,
        JSON.stringify(redactedRaw),
      ],
    );
  }
}

/**
 * Fold one collector result into the snapshot: merge redacted raw, bump counters,
 * and finalize the snapshot once no queued/running jobs remain.
 */
async function applyResultToSnapshot(
  job: ClaimedJob,
  result: CollectorResult,
): Promise<void> {
  const redactedRaw = redactSnapshot({ [result.service]: result.raw });

  await query(
    `UPDATE soc2_config_snapshots
        SET raw_redacted = raw_redacted || $2::jsonb,
            services_completed = services_completed + 1,
            services_failed = services_failed + $3,
            findings_count = findings_count + $4
      WHERE id = $1`,
    [
      job.snapshot_id,
      JSON.stringify(redactedRaw),
      result.ok ? 0 : 1,
      result.findings.length,
    ],
  );

  // Finalize if this was the last outstanding job.
  const remaining = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM soc2_snapshot_jobs
      WHERE snapshot_id = $1 AND state IN ('queued', 'running')`,
    [job.snapshot_id],
  );
  if (Number(remaining[0]?.n ?? 0) === 0) {
    await query(
      `UPDATE soc2_config_snapshots
          SET status = CASE WHEN services_failed > 0 THEN 'partial' ELSE 'complete' END,
              partial = services_failed > 0,
              completed_at = now(),
              error = CASE WHEN services_failed > 0
                           THEN services_failed::text || ' collector(s) failed — see per-service rows'
                           ELSE NULL END
        WHERE id = $1`,
      [job.snapshot_id],
    );
  }
}

/**
 * Process a single claimed job end-to-end: assume the role, run the collector,
 * persist findings, and update the snapshot. Fails soft — a failure marks the
 * job failed with the exact AWS action and still advances the snapshot.
 */
async function processJob(job: ClaimedJob): Promise<{ service: string; outcome: string }> {
  const trust: ConnectionTrust = {
    id: job.connection_id,
    organization_id: job.organization_id,
    role_arn: job.role_arn,
    external_id: job.external_id,
    region: job.region,
    aws_account_id: job.aws_account_id,
  };

  let result: CollectorResult;
  try {
    const creds = await assumeRole(trust);
    result = await runCollector(job.service, creds, job.region || "us-east-1");
  } catch (e) {
    const action = (e as Error & { failingAction?: string }).failingAction || "sts:AssumeRole";
    result = {
      service: job.service,
      ok: false,
      findings: [],
      raw: {},
      failingAction: action,
      error: `${action}: ${(e as Error).message}`,
    };
  }

  try {
    await persistFindings(job, result.findings);
  } catch (e) {
    result = {
      ...result,
      ok: false,
      failingAction: result.failingAction ?? "persist",
      error: `persist failed: ${(e as Error).message}`,
    };
  }

  await query(
    `UPDATE soc2_snapshot_jobs
        SET state = $2, findings_count = $3, failing_action = $4, last_error = $5,
            finished_at = now(), updated_at = now()
      WHERE id = $1`,
    [
      job.id,
      result.ok ? "done" : "failed",
      result.findings.length,
      result.ok ? null : result.failingAction ?? null,
      result.ok ? null : result.error ?? null,
    ],
  );

  await applyResultToSnapshot(job, result);
  return { service: job.service, outcome: result.ok ? "done" : "failed" };
}

/**
 * Process one chunk of queued jobs. Called once per cron invocation; `maxJobs`
 * bounds the work so a single serverless invocation stays within its duration
 * limit while the minute-level cron drains the remainder on later ticks.
 */
export async function runJobChunk(
  maxJobs = 3,
): Promise<{ processed: Array<{ service: string; outcome: string }>; claimed: number }> {
  const jobs = await claimJobs(maxJobs);
  const processed: Array<{ service: string; outcome: string }> = [];
  for (const job of jobs) {
    processed.push(await processJob(job));
  }
  return { processed, claimed: jobs.length };
}
