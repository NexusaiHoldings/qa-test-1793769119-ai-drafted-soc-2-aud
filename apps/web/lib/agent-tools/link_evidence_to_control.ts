import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";
import { query } from "@repo/db";

type Args = {
  organization_id?: unknown;
  control_id?: unknown;
  citation_source?: unknown;
  citation_artifact_id?: unknown;
  citation_finding_id?: unknown;
  citation_arn?: unknown;
  citation_observed_at?: unknown;
  notes?: unknown;
  confirmed?: unknown;
};

type LinkEvidenceRow = {
  id: string;
  organization_id: string;
  control_id: string;
  citation_source: string;
  citation_artifact_id: string | null;
  citation_finding_id: string | null;
  citation_arn: string | null;
  citation_observed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

function asOptionalUuid(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return asUuid(value);
}

function asOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asOptionalIso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "1" || v === "yes";
  }
  if (typeof value === "number") return value === 1;
  return false;
}

export async function handleLinkEvidenceToControl(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const organizationId = asUuid(args.organization_id);
  const controlId = asUuid(args.control_id);
  const citationSource = asOptionalString(args.citation_source);
  const citationArtifactId = asOptionalUuid(args.citation_artifact_id);
  const citationFindingId = asOptionalUuid(args.citation_finding_id);
  const citationArn = asOptionalString(args.citation_arn);
  const citationObservedAt = asOptionalIso(args.citation_observed_at);
  const notes = asOptionalString(args.notes);
  const confirmed = asBoolean(args.confirmed);

  if (!confirmed) {
    return {
      ok: false,
      error: "confirmation_required",
      message:
        "This mutation requires explicit confirmation. Re-run with confirmed=true.",
    } as HandlerResult;
  }

  if (!organizationId || !controlId) {
    return {
      ok: false,
      error: "invalid_arguments",
      message: "organization_id and control_id must be valid UUIDs.",
    } as HandlerResult;
  }

  if (!citationSource || (citationSource !== "artifact" && citationSource !== "finding")) {
    return {
      ok: false,
      error: "invalid_arguments",
      message: "citation_source must be either 'artifact' or 'finding'.",
    } as HandlerResult;
  }

  if (citationSource === "artifact" && !citationArtifactId) {
    return {
      ok: false,
      error: "invalid_arguments",
      message: "citation_artifact_id is required when citation_source='artifact'.",
    } as HandlerResult;
  }

  if (citationSource === "finding" && !citationFindingId) {
    return {
      ok: false,
      error: "invalid_arguments",
      message: "citation_finding_id is required when citation_source='finding'.",
    } as HandlerResult;
  }

  if (citationSource === "artifact" && citationFindingId) {
    return {
      ok: false,
      error: "invalid_arguments",
      message: "citation_finding_id must be omitted when citation_source='artifact'.",
    } as HandlerResult;
  }

  if (citationSource === "finding" && citationArtifactId) {
    return {
      ok: false,
      error: "invalid_arguments",
      message: "citation_artifact_id must be omitted when citation_source='finding'.",
    } as HandlerResult;
  }

  try {
    const insertSql = `
      INSERT INTO soc2_control_evidence_links (
        organization_id,
        control_id,
        citation_source,
        citation_artifact_id,
        citation_finding_id,
        citation_arn,
        citation_observed_at,
        notes,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9)
      RETURNING
        id,
        organization_id,
        control_id,
        citation_source,
        citation_artifact_id,
        citation_finding_id,
        citation_arn,
        citation_observed_at,
        notes,
        created_at,
        updated_at
    `;

    const actorId =
      (ctx as { actorId?: string | null }).actorId ??
      (ctx as { userId?: string | null }).userId ??
      null;

    const rows = (await query(insertSql, [
      organizationId,
      controlId,
      citationSource,
      citationArtifactId,
      citationFindingId,
      citationArn,
      citationObservedAt,
      notes,
      actorId,
    ])) as LinkEvidenceRow[];

    const created = rows[0] ?? null;
    if (!created) {
      return {
        ok: false,
        error: "insert_failed",
        message: "Failed to create evidence link.",
      } as HandlerResult;
    }

    return {
      ok: true,
      data: {
        link: created,
      },
    } as HandlerResult;
  } catch (error) {
    return {
      ok: false,
      error: "db_error",
      message: "Unable to link evidence to control.",
      details: error instanceof Error ? error.message : "unknown_error",
    } as HandlerResult;
  }
}
