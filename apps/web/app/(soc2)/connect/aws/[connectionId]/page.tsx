/**
 * /connect/aws/[connectionId] — connection detail + live snapshot progress (F1-002).
 *
 * Verify trust, trigger a snapshot, and watch per-service collection progress with
 * animated status pills. Collectors fail soft, so the error state quotes the exact
 * service + IAM action that failed. While a snapshot is running the page auto-refreshes
 * (server-rendered, no client bundle) to show live progress.
 */

import type { JSX } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import {
  getActiveOrg,
  getConnectionById,
  getLatestSnapshot,
  getSnapshotJobs,
  getFindings,
  recordTrustVerification,
  createSnapshot,
  runJobChunk,
  canManageConnections,
  type Soc2Job,
  type Soc2Finding,
} from "@/lib/soc2/aws/snapshot-jobs";
import { verifyTrust } from "@/lib/soc2/aws/assume-role";
import { SERVICE_LABELS, SERVICE_ORDER } from "@/lib/soc2/aws/collectors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DETAIL_STYLE = `
.soc2-pill { display:inline-block; padding:0.1rem 0.6rem; border-radius:999px; font-size:0.75rem;
  border:1px solid var(--substrate-border,#555); }
.soc2-pill.running, .soc2-pill.queued { animation:soc2pulse 1.2s ease-in-out infinite;
  border-color:var(--substrate-accent,#4f8cff); }
.soc2-pill.pass, .soc2-pill.done, .soc2-pill.complete { color:#1a7f37; border-color:#1a7f37; }
.soc2-pill.fail, .soc2-pill.failed, .soc2-pill.partial { color:#b35900; border-color:#b35900; }
.soc2-pill.critical, .soc2-pill.high { color:#c01c28; border-color:#c01c28; }
.soc2-accent { background:var(--substrate-accent,#4f8cff); color:#fff; border:none; }
@keyframes soc2pulse { 0%,100% { opacity:1; } 50% { opacity:0.35; } }
`;

function pct(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

async function verifyTrustAction(formData: FormData): Promise<void> {
  "use server";
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const org = await getActiveOrg(user.id);
  const connectionId = String(formData.get("connection_id") ?? "");
  if (!org || !canManageConnections(org.role)) {
    redirect(`/connect/aws/${connectionId}?error=forbidden`);
  }
  const conn = await getConnectionById(org!.id, connectionId);
  if (!conn) redirect("/connect/aws");
  const result = await verifyTrust({
    id: conn!.id,
    organization_id: conn!.organization_id,
    role_arn: conn!.role_arn,
    external_id: conn!.external_id,
    region: conn!.region,
    aws_account_id: conn!.aws_account_id,
  });
  await recordTrustVerification({ orgId: org!.id, connectionId, result });
  redirect(`/connect/aws/${connectionId}`);
}

async function startSnapshotAction(formData: FormData): Promise<void> {
  "use server";
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const org = await getActiveOrg(user.id);
  const connectionId = String(formData.get("connection_id") ?? "");
  if (!org || !canManageConnections(org.role)) {
    redirect(`/connect/aws/${connectionId}?error=forbidden`);
  }
  const conn = await getConnectionById(org!.id, connectionId);
  if (!conn) redirect("/connect/aws");
  await createSnapshot({ orgId: org!.id, connectionId });
  // Drain chunks immediately (fluid compute) so the snapshot completes without
  // waiting on the minute-level cron; the cron still exists to drain any leftover
  // or retried jobs. Bounded iteration count as a safety cap.
  for (let i = 0; i < 6; i++) {
    const r = await runJobChunk(3).catch(() => ({ claimed: 0, processed: [] }));
    if (r.claimed === 0) break;
  }
  redirect(`/connect/aws/${connectionId}`);
}

export default async function ConnectionDetailPage({
  params,
  searchParams,
}: {
  params: { connectionId: string };
  searchParams?: { [key: string]: string | string[] | undefined };
}): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) {
    return (
      <main>
        <h1>AWS connection</h1>
        <p>
          Please <Link href="/login">log in</Link> to view this connection.
        </p>
      </main>
    );
  }

  const org = await getActiveOrg(user.id);
  if (!org) redirect("/connect/aws");

  const conn = await getConnectionById(org!.id, params.connectionId).catch(() => null);
  if (!conn) {
    return (
      <main>
        <h1>AWS connection</h1>
        <p className="empty">
          This connection was not found. <Link href="/connect/aws">Back to connect</Link>.
        </p>
      </main>
    );
  }

  const manage = canManageConnections(org!.role);
  const snapshot = await getLatestSnapshot(org!.id, conn.id).catch(() => null);
  const jobs: Soc2Job[] = snapshot
    ? await getSnapshotJobs(org!.id, snapshot.id).catch(() => [])
    : [];
  const findings: Soc2Finding[] = snapshot
    ? await getFindings(org!.id, snapshot.id).catch(() => [])
    : [];
  const running = snapshot?.status === "running";
  const jobByService = new Map(jobs.map((j) => [j.service, j]));
  const failedJobs = jobs.filter((j) => j.state === "failed");

  return (
    <main>
      <style dangerouslySetInnerHTML={{ __html: DETAIL_STYLE }} />
      {/* Auto-refresh while collection is in flight → live progress, no client JS. */}
      {running && <meta httpEquiv="refresh" content="4" />}

      <h1>AWS connection</h1>
      <p className="muted">
        {conn.aws_account_id ? `Account ${conn.aws_account_id} · ` : ""}
        Region {conn.region} ·{" "}
        <span className={`soc2-pill ${conn.status}`}>{conn.status}</span>
      </p>
      <p>
        <Link href="/connect/aws">← Back to setup</Link>
      </p>

      {searchParams?.error === "forbidden" && (
        <p className="soc2-pill fail" role="alert">
          Only an owner or admin can manage this connection.
        </p>
      )}

      <section className="card">
        <h2>Trust</h2>
        <p className="muted">
          ExternalId <code>{conn.external_id}</code>
        </p>
        {conn.role_arn ? (
          <p className="muted">
            Role <code>{conn.role_arn}</code>
          </p>
        ) : (
          <p className="muted">No role ARN saved yet — complete step 2 on the setup page.</p>
        )}
        {conn.trust_verified ? (
          <p>
            <span className="soc2-pill pass">trust verified</span>
            {conn.last_verified_at ? ` · ${new Date(conn.last_verified_at).toUTCString()}` : ""}
          </p>
        ) : (
          <>
            {conn.last_error && (
              <p className="soc2-pill fail" role="alert">
                Verification failed: {conn.last_error}
              </p>
            )}
            {manage && conn.role_arn && (
              <form action={verifyTrustAction}>
                <input type="hidden" name="connection_id" value={conn.id} />
                <button type="submit" className="btn soc2-accent">
                  Verify trust
                </button>
              </form>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h2>Configuration snapshot</h2>
        {!snapshot ? (
          <div className="empty">
            <p>No snapshots yet.</p>
            <p className="muted">
              Run your first read-only collection across IAM, S3, CloudTrail, Config,
              GuardDuty, KMS, Security Groups, RDS, VPC flow logs and CloudWatch.
            </p>
            {manage && conn.trust_verified && (
              <form action={startSnapshotAction}>
                <input type="hidden" name="connection_id" value={conn.id} />
                <button type="submit" className="btn soc2-accent">
                  Run first snapshot
                </button>
              </form>
            )}
            {manage && !conn.trust_verified && (
              <p className="muted">Verify trust first, then you can run a snapshot.</p>
            )}
          </div>
        ) : (
          <>
            <p>
              Version {snapshot.version} ·{" "}
              <span className={`soc2-pill ${snapshot.status}`}>{snapshot.status}</span>
              {snapshot.partial && " (partial)"} · {snapshot.findings_count} findings ·{" "}
              {pct(snapshot.services_completed, snapshot.services_total)}% complete
            </p>
            {snapshot.error && (
              <p className="soc2-pill partial" role="alert">
                {snapshot.error}
              </p>
            )}

            <table>
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Status</th>
                  <th>Findings</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {SERVICE_ORDER.map((svc) => {
                  const job = jobByService.get(svc);
                  const state = job?.state ?? "queued";
                  return (
                    <tr key={svc}>
                      <td>{SERVICE_LABELS[svc] ?? svc}</td>
                      <td>
                        <span className={`soc2-pill ${state}`}>{state}</span>
                      </td>
                      <td>{job?.findings_count ?? 0}</td>
                      <td>
                        {job?.state === "failed" && job.failing_action ? (
                          <span className="muted">
                            Failed on <code>{job.failing_action}</code>
                            {job.last_error ? ` — ${job.last_error}` : ""}
                          </span>
                        ) : (
                          ""
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {failedJobs.length > 0 && (
              <p className="soc2-pill fail" role="alert">
                {failedJobs.length} collector(s) failed — partial snapshot. First failure:{" "}
                <code>{failedJobs[0].failing_action}</code>
              </p>
            )}

            {manage && !running && conn.trust_verified && (
              <form action={startSnapshotAction}>
                <input type="hidden" name="connection_id" value={conn.id} />
                <button type="submit" className="btn soc2-accent">
                  Run new snapshot
                </button>
              </form>
            )}
          </>
        )}
      </section>

      {findings.length > 0 && (
        <section className="card">
          <h2>Findings</h2>
          <table>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Service</th>
                <th>Check</th>
                <th>Resource</th>
                <th>Observation</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f) => (
                <tr key={f.id}>
                  <td>
                    <span className={`soc2-pill ${f.severity}`}>{f.severity}</span>
                  </td>
                  <td>{SERVICE_LABELS[f.service] ?? f.service}</td>
                  <td>
                    <code>{f.check_id}</code>
                  </td>
                  <td>{f.resource_id ?? "—"}</td>
                  <td>
                    {f.title}
                    {f.detail ? <div className="muted">{f.detail}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
