/**
 * GET /api/cron/soc2-job-runner — chunked AWS collection runner (F1-002).
 *
 * The connector enqueues one soc2_snapshot_jobs row per AWS service when a
 * snapshot is requested. This Vercel Cron route (scheduled every minute in
 * vercel.json, substrate-owned) claims a small chunk of queued jobs per
 * invocation, assumes the customer's read-only role, runs the matching
 * collector, redacts + persists findings, and advances the snapshot. Bounding
 * the chunk keeps each invocation within the Vercel function duration limit;
 * subsequent ticks drain the rest. A trigger from the UI (?snapshot=...) may
 * also hit this route to kick off the first chunk immediately.
 *
 * Auth: when CRON_SECRET is set, Vercel sends `Authorization: Bearer <secret>`;
 * we validate it. Unset (local/dev) → unguarded. The route only ever runs
 * collection that the app itself enqueued, against a read-only assumed role.
 */

import { NextResponse } from "next/server";
import { runJobChunk } from "@/lib/soc2/aws/snapshot-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // pg + AWS SDK — not edge-compatible
export const maxDuration = 300; // fluid compute: allow the chunk to finish

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // unguarded in dev; prod sets CRON_SECRET
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

/** How many jobs to process per invocation (overridable via ?chunk=). */
function chunkSize(request: Request): number {
  const url = new URL(request.url);
  const raw = Number(url.searchParams.get("chunk"));
  if (Number.isFinite(raw) && raw >= 1 && raw <= 10) return Math.floor(raw);
  const env = Number(process.env.SOC2_JOB_CHUNK_SIZE);
  if (Number.isFinite(env) && env >= 1 && env <= 10) return Math.floor(env);
  return 3;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!cronAuthorized(request)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  if (!process.env.DATABASE_URL) {
    // Preview deploy without a DB — nothing to do, don't 500.
    return NextResponse.json({ skipped: true, reason: "no DATABASE_URL" });
  }

  try {
    const result = await runJobChunk(chunkSize(request));
    console.info(
      JSON.stringify({
        at: "soc2-job-runner",
        claimed: result.claimed,
        processed: result.processed,
      }),
    );
    return NextResponse.json({
      ok: true,
      claimed: result.claimed,
      processed: result.processed,
    });
  } catch (e) {
    console.error(
      JSON.stringify({ at: "soc2-job-runner", error: (e as Error).message }),
    );
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
