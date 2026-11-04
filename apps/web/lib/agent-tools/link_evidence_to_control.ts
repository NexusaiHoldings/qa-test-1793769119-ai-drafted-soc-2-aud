import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";
import { sql } from "@repo/db";

type Args = {
  organization_id?: unknown;
  control_id?: unknown;
  citation_source_type?: unknown;
  citation_source_id?: unknown;
  resource_arn?: unknown;
  observed_at?: unknown;
};

type CitationSourceType = "artifact" | "finding";

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asIsoDateTimeOrNull(value: unknown): string | null {
  const s = asNonEmptyString(value);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function normalizeCitationSourceType(value: unknown): CitationSourceType | null {
  const s = asNonEmptyString(value)?.toLowerCase();
  if (s === "artifact" || s === "finding") return s;
  return null;
}

function badRequest(message: string): HandlerResult {
  return {
    ok: false,
    error: {
      code: "invalid_arguments",
      message,
    },
  };
}

export async function handleLinkEvidenceToControl(
  _ctx: HandlerContext,
  args: Args
): Promise<HandlerResult> {
  const organizationId = asNonEmptyString(args.organization_id);
  const controlId = asNonEmptyString(args.control_id);
  const citationSourceType = normalizeCitationSourceType(args.citation_source_type);
  const citationSourceId = asNonEmptyString(args.citation_source_id);
  const resourceArn = asNonEmptyString(args.resource_arn);
  const observedAt = asIsoDateTimeOrNull(args.observed_at);

  if (!organizationId) return badRequest("organization_id is required");
  if (!controlId) return badRequest("control_id is required");
  if (!citationSourceType) {
    return badRequest("citation_source_type is required and must be 'artifact' or 'finding'");
  }
  if (!citationSourceId) return badRequest("citation_source_id is required");
  if (!resourceArn) return badRequest("resource_arn is required");
  if (!observedAt) return badRequest("observed_at is required and must be a valid datetime");

  try {
    const rows = await sql<{
      id: string;
      organization_id: string;
      control_id: string;
      citation_source_type: string;
      citation_source_id: string;
      resource_arn: string;
      observed_at: string;
      created_at: string;
      updated_at: string;
    }[]>`
      INSERT INTO soc2_control_evidence_links (
        organization_id,
        control_id,
        citation_source_type,
        citation_source_id,
        resource_arn,
        observed_at
      )
      VALUES (
        ${organizationId},
        ${controlId},
        ${citationSourceType},
        ${citationSourceId},
        ${resourceArn},
        ${observedAt}::timestamptz
      )
      RETURNING
        id,
        organization_id,
        control_id,
        citation_source_type,
        citation_source_id,
        resource_arn,
        observed_at,
        created_at,
        updated_at
    `;

    const inserted = rows[0];
    if (!inserted) {
      return {
        ok: false,
        error: {
          code: "write_failed",
          message: "Failed to create soc2_control_evidence_links row",
        },
      };
    }

    return {
      ok: true,
      data: {
        link: inserted,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown database error";
    return {
      ok: false,
      error: {
        code: "db_error",
        message,
      },
    };
  }
}
