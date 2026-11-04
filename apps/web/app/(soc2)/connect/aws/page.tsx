/**
 * /connect/aws — AWS read-only connector (F1-002).
 *
 * Three-step stepper: (1) Create role via one-click CloudFormation quick-create,
 * (2) Verify trust by pasting the role ARN, (3) First snapshot. No long-lived
 * keys are ever stored — only the per-org ExternalId + role ARN. Mutations run as
 * server actions (no sibling route.ts to avoid the App Router collision rule).
 */

import type { JSX } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import {
  ensureConnection,
  getActiveOrg,
  getLatestSnapshot,
  setConnectionRole,
  canManageConnections,
  type Soc2Connection,
} from "@/lib/soc2/aws/snapshot-jobs";
import { buildQuickCreateUrl, anchorAccountId } from "@/lib/soc2/aws/assume-role";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STEP_STYLE = `
.soc2-stepper { display:flex; gap:0.75rem; flex-wrap:wrap; margin:1.25rem 0; }
.soc2-step { flex:1 1 180px; border:1px solid var(--substrate-border,#333); border-radius:10px;
  padding:0.85rem 1rem; opacity:0.55; }
.soc2-step.active { opacity:1; border-color:var(--substrate-accent,#4f8cff); }
.soc2-step.done { opacity:1; }
.soc2-step .num { display:inline-flex; width:1.6rem; height:1.6rem; border-radius:50%;
  align-items:center; justify-content:center; border:1px solid currentColor; margin-right:0.5rem;
  font-size:0.8rem; }
.soc2-step.done .num { background:var(--substrate-accent,#4f8cff); color:#fff; border-color:transparent; }
.soc2-chip { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; border:1px dashed
  var(--substrate-border,#555); border-radius:8px; padding:0.4rem 0.6rem; display:inline-flex;
  gap:0.6rem; align-items:center; }
.soc2-accent { background:var(--substrate-accent,#4f8cff); color:#fff; border:none; }
.soc2-pill { display:inline-block; padding:0.1rem 0.6rem; border-radius:999px; font-size:0.75rem;
  border:1px solid var(--substrate-border,#555); }
.soc2-pill.running { animation:soc2pulse 1.2s ease-in-out infinite; border-color:var(--substrate-accent,#4f8cff); }
.soc2-pill.pass, .soc2-pill.done, .soc2-pill.complete { color:#1a7f37; border-color:#1a7f37; }
.soc2-pill.fail, .soc2-pill.failed, .soc2-pill.partial { color:#b35900; border-color:#b35900; }
@keyframes soc2pulse { 0%,100% { opacity:1; } 50% { opacity:0.35; } }
`;

async function connectAwsAction(formData: FormData): Promise<void> {
  "use server";
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const org = await getActiveOrg(user.id);
  if (!org || !canManageConnections(org.role)) {
    redirect("/connect/aws?error=forbidden");
  }
  const connectionId = String(formData.get("connection_id") ?? "");
  const roleArn = String(formData.get("role_arn") ?? "").trim();
  const region = String(formData.get("region") ?? "us-east-1").trim();
  if (!connectionId || !/^arn:aws[a-z-]*:iam::\d{12}:role\/.+/.test(roleArn)) {
    redirect("/connect/aws?error=invalid_arn");
  }
  const accountMatch = roleArn.match(/iam::(\d{12}):/);
  await setConnectionRole({
    orgId: org!.id,
    connectionId,
    roleArn,
    awsAccountId: accountMatch ? accountMatch[1] : null,
    region: region || "us-east-1",
  });
  redirect(`/connect/aws/${connectionId}`);
}

export default async function ConnectAwsPage({
  searchParams,
}: {
  searchParams?: { [key: string]: string | string[] | undefined };
}): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) {
    return (
      <main>
        <h1>Connect AWS</h1>
        <p>
          Please <Link href="/login">log in</Link> to connect your AWS account.
        </p>
      </main>
    );
  }

  const org = await getActiveOrg(user.id);
  if (!org) {
    return (
      <main>
        <h1>Connect AWS</h1>
        <p className="muted">
          You need an organization before connecting AWS. Create one from{" "}
          <Link href="/org">your organization settings</Link>.
        </p>
      </main>
    );
  }

  let connection: Soc2Connection | null = null;
  let dbError = false;
  try {
    connection = await ensureConnection({ orgId: org.id, userId: user.id });
  } catch {
    dbError = true;
  }

  if (dbError || !connection) {
    return (
      <main>
        <style dangerouslySetInnerHTML={{ __html: STEP_STYLE }} />
        <h1>Connect AWS</h1>
        <p className="muted">
          The connector is being prepared. Refresh in a moment — if this persists, the
          database may not be provisioned yet.
        </p>
      </main>
    );
  }

  const quickCreate = buildQuickCreateUrl({
    externalId: connection.external_id,
    region: connection.region,
  });
  const latest = await getLatestSnapshot(org.id, connection.id).catch(() => null);
  const manage = canManageConnections(org.role);

  const hasRole = !!connection.role_arn;
  const verified = connection.trust_verified;

  return (
    <main>
      <style dangerouslySetInnerHTML={{ __html: STEP_STYLE }} />
      <h1>Connect AWS (read-only)</h1>
      <p>
        Grant Nexus a read-only view of your AWS security posture. We create a role that
        trusts our anchor account with a unique ExternalId — <strong>no access keys are
        ever stored</strong>.
      </p>

      {searchParams?.error === "invalid_arn" && (
        <p className="soc2-pill fail" role="alert">
          That role ARN didn&apos;t look valid. It should look like{" "}
          <code>arn:aws:iam::123456789012:role/NexusSoc2ReadOnly</code>.
        </p>
      )}
      {searchParams?.error === "forbidden" && (
        <p className="soc2-pill fail" role="alert">
          Only an organization owner or admin can connect AWS.
        </p>
      )}

      <div className="soc2-stepper">
        <div className={`soc2-step ${hasRole ? "done" : "active"}`}>
          <div>
            <span className="num">1</span>
            <strong>Create role</strong>
          </div>
          <p className="muted">Launch the read-only CloudFormation stack in your account.</p>
        </div>
        <div className={`soc2-step ${verified ? "done" : hasRole ? "active" : ""}`}>
          <div>
            <span className="num">2</span>
            <strong>Verify trust</strong>
          </div>
          <p className="muted">Paste the role ARN so we can assume it.</p>
        </div>
        <div className={`soc2-step ${latest ? "done" : verified ? "active" : ""}`}>
          <div>
            <span className="num">3</span>
            <strong>First snapshot</strong>
          </div>
          <p className="muted">Collect your first configuration snapshot.</p>
        </div>
      </div>

      <section className="card">
        <h2>Step 1 — Create the read-only role</h2>
        <p>Your per-organization ExternalId (keep this — CloudFormation asks for it):</p>
        <p>
          <span className="soc2-chip">
            <span data-externalid id="soc2-external-id">{connection.external_id}</span>
            <button type="button" className="btn secondary" data-copy={connection.external_id}>
              Copy
            </button>
          </span>
        </p>
        {anchorAccountId() && (
          <p className="muted">
            Trust anchor account: <code>{anchorAccountId()}</code>
          </p>
        )}
        <p>
          <a className="btn soc2-accent" href={quickCreate} target="_blank" rel="noreferrer">
            Create read-only role
          </a>
        </p>
      </section>

      <section className="card">
        <h2>Step 2 — Verify trust</h2>
        {!manage ? (
          <p className="muted">Only an owner or admin can complete the connection.</p>
        ) : (
          <form action={connectAwsAction}>
            <input type="hidden" name="connection_id" value={connection.id} />
            <label htmlFor="role_arn">Role ARN</label>
            <input
              id="role_arn"
              name="role_arn"
              type="text"
              placeholder="arn:aws:iam::123456789012:role/NexusSoc2ReadOnly"
              defaultValue={connection.role_arn ?? ""}
              required
            />
            <label htmlFor="region">Primary region</label>
            <input id="region" name="region" type="text" defaultValue={connection.region} />
            <button type="submit" className="btn soc2-accent">
              Save &amp; verify trust
            </button>
          </form>
        )}
      </section>

      {hasRole && (
        <section className="card">
          <h2>Connection</h2>
          <p>
            Status:{" "}
            <span className={`soc2-pill ${connection.status}`}>{connection.status}</span>
          </p>
          <p>
            <Link className="btn" href={`/connect/aws/${connection.id}`}>
              Open connection &amp; run snapshot →
            </Link>
          </p>
        </section>
      )}

      {/* Static copy affordance — no user input is injected into the script body;
          the value is read from the HTML-escaped data-copy attribute. */}
      <script
        dangerouslySetInnerHTML={{
          __html:
            "document.addEventListener('click',function(e){var t=e.target;" +
            "if(t&&t.getAttribute&&t.getAttribute('data-copy')){" +
            "try{navigator.clipboard.writeText(t.getAttribute('data-copy'));" +
            "var o=t.textContent;t.textContent='Copied';" +
            "setTimeout(function(){t.textContent=o;},1500);}catch(_){}}}); ",
        }}
      />
    </main>
  );
}
