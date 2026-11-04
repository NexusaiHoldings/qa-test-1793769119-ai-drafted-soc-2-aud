import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  organizationId?: unknown;
  runId?: unknown;
  findings?: unknown;
  items?: unknown;
  actorUserId?: unknown;
};

type RemediationInput = {
  findingId: string;
  title: string;
  awsStep: string;
  suggestedOwner: string;
  estimatedHours: number;
  priority: "low" | "medium" | "high" | "critical";
};

type QueryableDb = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: Record<string, unknown>[] }>;
};

function asDb(ctx: HandlerContext): QueryableDb | null {
  const maybe = ctx as unknown as { db?: QueryableDb };
  if (maybe?.db && typeof maybe.db.query === "function") return maybe.db;
  return null;
}

function stringValue(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function numberValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function parsePriority(v: unknown): RemediationInput["priority"] {
  if (v === "critical" || v === "high" || v === "medium" || v === "low") return v;
  return "medium";
}

function parseItems(raw: unknown): RemediationInput[] {
  if (!Array.isArray(raw)) return [];
  const parsed: RemediationInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const findingId = stringValue(rec.findingId);
    const title = stringValue(rec.title);
    const awsStep = stringValue(rec.awsStep ?? rec.step);
    const suggestedOwner = stringValue(rec.suggestedOwner ?? rec.owner);
    const estimatedHours = numberValue(rec.estimatedHours ?? rec.hours);
    if (!findingId || !title || !awsStep || !suggestedOwner || estimatedHours === null) continue;
    parsed.push({
      findingId,
      title,
      awsStep,
      suggestedOwner,
      estimatedHours,
      priority: parsePriority(rec.priority),
    });
  }
  return parsed;
}

function ok(data: Record<string, unknown>): HandlerResult {
  return {
    ok: true,
    data,
  } as unknown as HandlerResult;
}

function err(code: string, message: string): HandlerResult {
  return {
    ok: false,
    error: { code, message },
  } as unknown as HandlerResult;
}

export async function handleCreateRemediationItems(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const organizationId = stringValue(args.organizationId);
  const runId = stringValue(args.runId);
  const items = parseItems(args.items ?? args.findings);

  if (!organizationId) return err("invalid_args", "organizationId is required");
  if (!runId) return err("invalid_args", "runId is required");
  if (items.length === 0) return err("invalid_args", "at least one remediation item is required");

  const db = asDb(ctx);
  if (!db) return err("db_unavailable", "Database handle is unavailable in handler context");

  try {
    const insertedIds: string[] = [];

    for (const item of items) {
      const result = await db.query(
        `
        INSERT INTO soc2_remediation_items (
          id,
          organization_id,
          run_id,
          finding_id,
          title,
          aws_step,
          suggested_owner,
          estimated_hours,
          priority,
          status,
          created_at,
          updated_at
        )
        VALUES (
          gen_random_uuid(),
          $1, $2, $3, $4, $5, $6, $7, $8, 'open', NOW(), NOW()
        )
        RETURNING id
        `,
        [
          organizationId,
          runId,
          item.findingId,
          item.title,
          item.awsStep,
          item.suggestedOwner,
          item.estimatedHours,
          item.priority,
        ],
      );

      const insertedId = stringValue(result.rows?.[0]?.id);
      if (insertedId) insertedIds.push(insertedId);
    }

    return ok({
      organizationId,
      runId,
      createdCount: insertedIds.length,
      remediationItemIds: insertedIds,
    });
  } catch (error) {
    return err(
      "create_failed",
      error instanceof Error ? error.message : "Failed to create remediation items",
    );
  }
}
