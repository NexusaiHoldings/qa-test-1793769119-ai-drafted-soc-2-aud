/**
 * link_evidence_to_control — company-local agent tool handler (F1-DT002).
 *
 * Capability class: confirm-gated MUTATION (autonomy = confirm).
 *
 * Writes ONE `soc2_control_evidence_links` row that records a confirmed
 * mapping between a SOC 2 control and a piece of observed evidence — an
 * artifact or a finding — together with the citation an auditor needs to
 * trace the claim: the resource ARN the evidence came from and the
 * observed_at timestamp it was collected at. Called AFTER an engineer
 * confirms a proposed control→evidence mapping.
 *
 * ── Where this runs (cross-boundary mutation bridge) ──────────────────────
 * Because autonomy is `confirm`, this tool never mutates inline in the
 * conversation surface. The ANALYSIS half (deterministic finding→control
 * retrieval that proposes the mapping) runs inline via the runtime's generic
 * LLM handler; the engineer confirms, and the structured, confirmed mapping is
 * carried into `args`. The MUTATION half routes through the cross-boundary
 * bridge: the runtime queues the approved action and
 * `app/api/cron/approved-actions/route.ts` dispatches it HERE (against this
 * company's DB) via DOMAIN_DISPATCH, then reports the result back through
 * `completeApprovedAction`, which persists the returned row into
 * `soc2_control_evidence_links` (the soc2 schema writer owns that DDL in
 * `packages/db/company/soc2.ts`).
 *
 * This handler is the authoritative assembler of a single link in the
 * snapshot → finding → control-link → claim citation chain auditors rely on:
 * every link resolves to a concrete resource ARN and an observed_at
 * timestamp, not a similarity score.
 *
 * Signature matches the lego-handler shape:
 *   (ctx: HandlerContext, args: Record<string, unknown>) => Promise<HandlerResult>
 */

import { randomUUID } from "node:crypto";
import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

/** The two kinds of evidence a control can be linked to. */
type CitationSourceType = "artifact" | "finding";

/** A durable soc2_control_evidence_links row, assembled from confirmed args. */
interface ControlEvidenceLink {
  readonly id: string;
  readonly organization_id: string;
  readonly control_id: string;
  readonly citation_source_type: CitationSourceType;
  readonly citation_source_id: string;
  readonly resource_arn: string;
  readonly observed_at: string;
  readonly confirmed_by: string | null;
  readonly note: string | null;
  readonly linked_by: string;
  readonly linked_at: string;
}

// ── small, total coercion helpers (tolerant of snake/camel arg casing) ──────

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function pick(args: Args, ...keys: string[]): string | null {
  for (const key of keys) {
    const found = asString(args[key]);
    if (found) return found;
  }
  return null;
}

/**
 * Normalize an evidence-source discriminator. Accepts either an explicit
 * `citation_source_type` of `artifact`/`finding`, or infers it from whichever
 * of `artifact_id` / `finding_id` was supplied.
 */
function normalizeSourceType(value: unknown): CitationSourceType | null {
  const s = asString(value)?.toLowerCase();
  if (s === "artifact" || s === "finding") return s;
  return null;
}

/**
 * Coerce a value to a canonical ISO-8601 UTC timestamp string, or null if it
 * is missing / unparseable. Keeps the stored observed_at deterministic so that
 * successive snapshot diffs compare cleanly.
 */
function asIsoTimestamp(value: unknown): string | null {
  const s = asString(value);
  if (!s) return null;
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export async function handleLinkEvidenceToControl(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  try {
    // 1 ─ Resolve + validate required arguments (tolerant of arg casing).
    const organizationId = pick(args, "organization_id", "organizationId", "org_id", "orgId");
    const controlId = pick(args, "control_id", "controlId", "soc2_control_id");

    // Source type can be explicit, or inferred from which id was provided.
    const explicitType = normalizeSourceType(
      args.citation_source_type ?? args.citationSourceType ?? args.source_type ?? args.sourceType,
    );
    const artifactId = pick(args, "artifact_id", "artifactId");
    const findingId = pick(args, "finding_id", "findingId");
    const sourceType: CitationSourceType | null =
      explicitType ?? (findingId ? "finding" : artifactId ? "artifact" : null);

    const citationSourceId =
      pick(args, "citation_source_id", "citationSourceId", "source_id", "sourceId") ??
      (sourceType === "finding" ? findingId : sourceType === "artifact" ? artifactId : null);

    const resourceArn = pick(args, "resource_arn", "resourceArn", "arn");
    const observedAt = asIsoTimestamp(
      args.observed_at ?? args.observedAt ?? args.collected_at ?? args.collectedAt,
    );

    const missing: string[] = [];
    if (!organizationId) missing.push("organization_id");
    if (!controlId) missing.push("control_id");
    if (!sourceType) missing.push("citation_source_type (artifact|finding)");
    if (!citationSourceId) missing.push("citation_source_id");
    if (!resourceArn) missing.push("resource_arn");
    if (!observedAt) missing.push("observed_at (valid datetime)");
    if (missing.length > 0) {
      return {
        status: 400,
        body: `link_evidence_to_control: missing or invalid arguments: ${missing.join(", ")}`,
      };
    }

    // 2 ─ Assemble the durable soc2_control_evidence_links row. The
    //     cross-boundary bridge persists this body; grounding it in a concrete
    //     ARN + observed_at is what makes the link auditable.
    const link: ControlEvidenceLink = {
      id: randomUUID(),
      organization_id: organizationId!,
      control_id: controlId!,
      citation_source_type: sourceType!,
      citation_source_id: citationSourceId!,
      resource_arn: resourceArn!,
      observed_at: observedAt!,
      confirmed_by: pick(args, "confirmed_by", "confirmedBy", "engineer_id", "reviewer_id"),
      note: pick(args, "note", "comment", "rationale"),
      linked_by: "agent:link_evidence_to_control",
      linked_at: new Date().toISOString(),
    };

    // 3 ─ Emit a domain event so the operator review queue + weekly digest can
    //     react. The EventBus contract is fire-and-forget; never let it throw.
    try {
      await ctx.events.publish("soc2.control_evidence_link.created", {
        link_id: link.id,
        organization_id: link.organization_id,
        control_id: link.control_id,
        citation_source_type: link.citation_source_type,
        citation_source_id: link.citation_source_id,
        resource_arn: link.resource_arn,
        observed_at: link.observed_at,
      });
    } catch (eventErr) {
      console.warn(
        JSON.stringify({
          evt: "soc2.control_evidence_link.event_publish_failed",
          link_id: link.id,
          error: String((eventErr as Error).message),
        }),
      );
    }

    // 4 ─ Structured log (no bare console.log) for the operator audit trail.
    console.info(
      JSON.stringify({
        evt: "soc2.link_evidence_to_control.completed",
        link_id: link.id,
        organization_id: link.organization_id,
        control_id: link.control_id,
        citation_source_type: link.citation_source_type,
        citation_source_id: link.citation_source_id,
        resource_arn: link.resource_arn,
        observed_at: link.observed_at,
      }),
    );

    // 5 ─ Return the completed mutation. The approved-actions bridge reports
    //     this body back to the runtime ledger, which persists the row into
    //     soc2_control_evidence_links and closes out the confirmed action.
    return {
      status: 201,
      body: {
        ok: true,
        tool: "link_evidence_to_control",
        autonomy: "confirm",
        requires_confirmation: true,
        control_evidence_link: link as unknown as Record<string, unknown>,
        summary: {
          control_id: link.control_id,
          citation_source_type: link.citation_source_type,
          citation_source_id: link.citation_source_id,
          resource_arn: link.resource_arn,
          observed_at: link.observed_at,
        },
      },
    };
  } catch (err) {
    const message = String((err as Error).message ?? err);
    console.error(
      JSON.stringify({ evt: "soc2.link_evidence_to_control.error", error: message }),
    );
    return { status: 500, body: `link_evidence_to_control failed: ${message}` };
  }
}
