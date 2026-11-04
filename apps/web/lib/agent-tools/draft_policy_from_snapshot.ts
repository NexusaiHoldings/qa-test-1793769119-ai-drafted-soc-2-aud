import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  organizationId?: string;
  snapshotId?: string;
  policyTemplateKey?: string;
  requestedByUserId?: string;
  confirm?: boolean;
  requestId?: string;
  [key: string]: unknown;
};

type ParsedClaim = {
  claimId: string;
  claimText: string;
  controlId: string | null;
  evidenceFindingIds: string[];
  confidence: number;
};

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function parseClaimsFromArgs(args: Args): ParsedClaim[] {
  const rawClaims = Array.isArray(args.claims) ? args.claims : [];
  return rawClaims
    .map((raw, idx) => {
      const record = (raw ?? {}) as Record<string, unknown>;
      const claimId = safeString(record.claimId) || `claim_${idx + 1}`;
      const claimText = safeString(record.claimText);
      const controlId = safeString(record.controlId) || null;
      const evidenceFindingIds = Array.isArray(record.evidenceFindingIds)
        ? record.evidenceFindingIds.map((v) => safeString(v)).filter(Boolean)
        : [];
      const confidenceRaw =
        typeof record.confidence === "number" ? record.confidence : 0.5;
      const confidence = Math.max(0, Math.min(1, confidenceRaw));
      return { claimId, claimText, controlId, evidenceFindingIds, confidence };
    })
    .filter((c) => c.claimText.length > 0);
}

export async function handleDraftPolicyFromSnapshot(
  ctx: HandlerContext,
  args: Args
): Promise<HandlerResult> {
  const organizationId = safeString(args.organizationId);
  const snapshotId = safeString(args.snapshotId);
  const policyTemplateKey = safeString(args.policyTemplateKey);
  const requestedByUserId =
    safeString(args.requestedByUserId) ||
    safeString((ctx as unknown as { userId?: string }).userId);
  const confirm = normalizeBoolean(args.confirm);

  if (!organizationId || !snapshotId || !policyTemplateKey || !requestedByUserId) {
    return {
      ok: false,
      error: "invalid_arguments",
      message:
        "organizationId, snapshotId, policyTemplateKey, and requestedByUserId are required.",
      data: {
        organizationId,
        snapshotId,
        policyTemplateKey,
        requestedByUserId,
      },
    } as HandlerResult;
  }

  if (!confirm) {
    return {
      ok: false,
      error: "confirmation_required",
      message:
        "This is a mutation tool and requires explicit confirm=true before execution.",
      data: {
        organizationId,
        snapshotId,
        policyTemplateKey,
      },
    } as HandlerResult;
  }

  const claims = parseClaimsFromArgs(args);
  const generatedAt = new Date().toISOString();

  const title = safeString(args.title) || `${policyTemplateKey} Policy`;
  const body =
    safeString(args.body) ||
    `Draft generated from snapshot ${snapshotId} for template ${policyTemplateKey} at ${generatedAt}.`;

  const versionRecord = {
    id: `pv_${crypto.randomUUID()}`,
    organizationId,
    snapshotId,
    policyTemplateKey,
    title,
    body,
    status: "draft",
    requestedByUserId,
    generatedAt,
    source: "agent_tool:draft_policy_from_snapshot",
  };

  const claimRecords = claims.map((claim) => ({
    id: `pc_${crypto.randomUUID()}`,
    policyVersionId: versionRecord.id,
    organizationId,
    snapshotId,
    claimId: claim.claimId,
    claimText: claim.claimText,
    controlId: claim.controlId,
    evidenceFindingIds: claim.evidenceFindingIds,
    confidence: claim.confidence,
    createdAt: generatedAt,
  }));

  return {
    ok: true,
    data: {
      autonomy: "human_review",
      tool: "draft_policy_from_snapshot",
      mutationPrepared: true,
      version: versionRecord,
      claims: claimRecords,
      summary: {
        claimsCount: claimRecords.length,
      },
    },
  } as HandlerResult;
}
