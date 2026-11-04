import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed: string = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeHours(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value * 100) / 100;
  }

  if (typeof value === "string") {
    const parsed: number = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed * 100) / 100;
    }
  }

  return null;
}

type RemediationCandidate = {
  gapId: string;
  step: string;
  suggestedOwner: string;
  estimatedHours: number;
  rationale?: string;
};

function parseCandidates(args: Args): RemediationCandidate[] {
  const candidatesRaw: unknown = args.candidates ?? args.items ?? args.remediation_items;
  if (!Array.isArray(candidatesRaw)) {
    return [];
  }

  const parsed: RemediationCandidate[] = [];

  for (const item of candidatesRaw) {
    if (!item || typeof item !== "object") continue;

    const rec: Record<string, unknown> = item as Record<string, unknown>;
    const gapId: string | null = asNonEmptyString(rec.gap_id ?? rec.gapId);
    const step: string | null = asNonEmptyString(rec.step ?? rec.concrete_step ?? rec.remediation_step);
    const suggestedOwner: string | null = asNonEmptyString(
      rec.suggested_owner ?? rec.suggestedOwner ?? rec.owner,
    );
    const estimatedHours: number | null = normalizeHours(
      rec.estimated_hours ?? rec.estimatedHours ?? rec.hours,
    );
    const rationale: string | null = asNonEmptyString(rec.rationale);

    if (!gapId || !step || !suggestedOwner || estimatedHours === null) {
      continue;
    }

    parsed.push({
      gapId,
      step,
      suggestedOwner,
      estimatedHours,
      ...(rationale ? { rationale } : {}),
    });
  }

  return parsed;
}

function ok(payload: Record<string, unknown>): HandlerResult {
  return {
    ok: true,
    ...payload,
  } as HandlerResult;
}

function fail(code: string, message: string, details?: Record<string, unknown>): HandlerResult {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  } as HandlerResult;
}

/**
 * Company-local mutation tool with confirm autonomy.
 * This handler intentionally does not execute DB writes inline; it packages
 * a deterministic mutation request for the cross-boundary bridge, which
 * performs confirm-gated persistence.
 */
export async function handleCreateRemediationItems(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const organizationId: string | null = asNonEmptyString(
    (args.organization_id ?? args.organizationId) as unknown,
  );
  const gapRunId: string | null = asNonEmptyString((args.gap_run_id ?? args.gapRunId) as unknown);

  if (!organizationId) {
    return fail("invalid_arguments", "organization_id is required.");
  }

  if (!gapRunId) {
    return fail("invalid_arguments", "gap_run_id is required.");
  }

  const candidates: RemediationCandidate[] = parseCandidates(args);
  if (candidates.length === 0) {
    return fail(
      "invalid_arguments",
      "At least one remediation candidate is required with gap_id, step, suggested_owner, and estimated_hours.",
    );
  }

  const idempotencyKey: string =
    asNonEmptyString((args.idempotency_key ?? args.idempotencyKey) as unknown) ??
    `create_remediation_items:${organizationId}:${gapRunId}:${candidates.length}`;

  const bridgePayload: Record<string, unknown> = {
    autonomy: "confirm",
    mutation: "create_remediation_items",
    organization_id: organizationId,
    gap_run_id: gapRunId,
    idempotency_key: idempotencyKey,
    remediation_items: candidates.map((c: RemediationCandidate) => ({
      gap_id: c.gapId,
      concrete_step: c.step,
      suggested_owner: c.suggestedOwner,
      estimated_hours: c.estimatedHours,
      ...(c.rationale ? { rationale: c.rationale } : {}),
    })),
    requested_by: {
      actor_id:
        (ctx as unknown as Record<string, unknown>)?.["actorId"] ??
        (ctx as unknown as Record<string, unknown>)?.["userId"] ??
        null,
    },
    metadata: {
      source_tool: "create_remediation_items",
      generated_at: new Date().toISOString(),
    },
  };

  return ok({
    status: "needs_confirmation",
    route: "cross_boundary_bridge",
    payload: bridgePayload,
    message:
      "Prepared remediation-item mutation request. Execute through the confirm-gated bridge to persist soc2_remediation_items.",
  });
}
