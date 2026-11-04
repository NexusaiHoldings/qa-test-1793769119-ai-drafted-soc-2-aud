/**
 * draft_policy_from_snapshot — company-local agent tool handler (F1-DT001).
 *
 * Capability class: confirm-gated MUTATION (autonomy = human_review).
 *
 * Generates ONE SOC 2 policy-document version from a completed snapshot's
 * findings and their control links, assembling the durable
 * `soc2_policy_versions` row plus its child `soc2_policy_claims` rows. Called
 * once per policy template after a snapshot completes, or when a reviewer
 * requests regeneration.
 *
 * ── Where this runs (cross-boundary mutation bridge) ──────────────────────
 * Because autonomy is `human_review`, this tool never executes inline in the
 * conversation surface. The ANALYSIS half (deterministic finding→control
 * retrieval + the grounded Claude-Sonnet draft) runs inline via the runtime's
 * generic LLM handler; its structured output is carried into `args`. The
 * MUTATION half routes through the cross-boundary bridge: the runtime queues
 * the approved action and `app/api/cron/approved-actions/route.ts` dispatches
 * it HERE (against this company's DB) via DOMAIN_DISPATCH, then reports the
 * result back through `completeApprovedAction`.
 *
 * This handler is the authoritative assembler of the versioned
 * snapshot → finding → control-link → claim chain auditors rely on: every
 * generated statement either cites a real finding id (status `supported`) or
 * is flagged `unsupported` for human review — directly attacking the
 * "AI hallucinations generating non-compliant policies" risk by making
 * grounding, not plausibility, the acceptance test.
 *
 * Signature matches the lego-handler shape:
 *   (ctx: HandlerContext, args: Record<string, unknown>) => Promise<HandlerResult>
 */

import { randomUUID } from "node:crypto";
import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

/** A redacted snapshot finding, as produced by the inline analysis step. */
interface SnapshotFinding {
  readonly findingId: string;
  readonly controlIds: string[];
  readonly summary: string;
  readonly resourceArn: string | null;
  readonly observedAt: string | null;
  readonly severity: string;
  readonly status: string;
}

/** A pre-generated claim handed in by the inline LLM draft (optional). */
interface ProvidedClaim {
  readonly statement: string;
  readonly controlId: string | null;
  readonly findingIds: string[];
}

/** A durable soc2_policy_claims row, grounded against the snapshot findings. */
interface PolicyClaim {
  readonly id: string;
  readonly policy_version_id: string;
  readonly organization_id: string;
  readonly control_id: string | null;
  readonly statement: string;
  readonly finding_ids: string[];
  readonly resource_arns: string[];
  readonly support_status: "supported" | "unsupported";
  readonly observed_at: string | null;
}

/** A durable soc2_policy_versions row. */
interface PolicyVersion {
  readonly id: string;
  readonly organization_id: string;
  readonly snapshot_id: string;
  readonly policy_template_id: string | null;
  readonly policy_key: string | null;
  readonly title: string;
  readonly version_number: number;
  readonly status: "pending_review" | "needs_changes";
  readonly body_markdown: string;
  readonly claim_count: number;
  readonly supported_count: number;
  readonly unsupported_count: number;
  readonly source: "snapshot" | "regeneration";
  readonly requested_by: string | null;
  readonly generated_by: string;
  readonly generated_at: string;
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toStringArray(value: unknown): string[] {
  const out: string[] = [];
  for (const item of asArray(value)) {
    const s = asString(item);
    if (s) out.push(s);
  }
  return out;
}

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  return null;
}

/**
 * Coerce the inline-analysis finding payload into typed, deduplicated
 * SnapshotFinding records. Tolerant of both snake_case and camelCase keys and
 * of a single control id provided as a scalar instead of an array.
 */
function normalizeFindings(raw: unknown): SnapshotFinding[] {
  const seen = new Set<string>();
  const findings: SnapshotFinding[] = [];
  for (const entry of asArray(raw)) {
    const rec = asRecord(entry);
    const findingId =
      asString(rec.finding_id) ?? asString(rec.findingId) ?? asString(rec.id);
    if (!findingId || seen.has(findingId)) continue;

    const controlIds = toStringArray(rec.control_ids ?? rec.controlIds);
    const singleControl = asString(rec.control_id) ?? asString(rec.controlId);
    if (singleControl && !controlIds.includes(singleControl)) controlIds.push(singleControl);

    const summary =
      asString(rec.summary) ??
      asString(rec.statement) ??
      asString(rec.description) ??
      "Finding recorded without a summary.";

    seen.add(findingId);
    findings.push({
      findingId,
      controlIds,
      summary,
      resourceArn: asString(rec.resource_arn) ?? asString(rec.resourceArn),
      observedAt: asString(rec.observed_at) ?? asString(rec.observedAt),
      severity: (asString(rec.severity) ?? "info").toLowerCase(),
      status: (asString(rec.status) ?? "observed").toLowerCase(),
    });
  }
  return findings;
}

/**
 * Coerce any claims the inline LLM draft already proposed. These are NOT
 * trusted — buildClaims re-grounds every cited finding id against the real
 * snapshot findings and downgrades anything uncited to `unsupported`.
 */
function normalizeProvidedClaims(raw: unknown): ProvidedClaim[] {
  const claims: ProvidedClaim[] = [];
  for (const entry of asArray(raw)) {
    const rec = asRecord(entry);
    const statement = asString(rec.statement) ?? asString(rec.text);
    if (!statement) continue;
    const findingIds = toStringArray(rec.finding_ids ?? rec.findingIds);
    const single = asString(rec.finding_id) ?? asString(rec.findingId);
    if (single && !findingIds.includes(single)) findingIds.push(single);
    claims.push({
      statement,
      controlId: asString(rec.control_id) ?? asString(rec.controlId),
      findingIds,
    });
  }
  return claims;
}

/**
 * Deterministic finding → control retrieval (no embeddings): group findings by
 * each control id they link to. Findings with no control link are collected
 * under the sentinel key `__unmapped__` so they still surface for review.
 * Keys are returned in stable sorted order so successive drafts of the same
 * snapshot diff cleanly.
 */
function buildControlIndex(findings: SnapshotFinding[]): Map<string, SnapshotFinding[]> {
  const grouped = new Map<string, SnapshotFinding[]>();
  for (const finding of findings) {
    const keys = finding.controlIds.length > 0 ? finding.controlIds : ["__unmapped__"];
    for (const key of keys) {
      const bucket = grouped.get(key);
      if (bucket) bucket.push(finding);
      else grouped.set(key, [finding]);
    }
  }
  return new Map([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Assemble the soc2_policy_claims rows.
 *
 * When the inline draft supplied claims, each is re-grounded: only finding ids
 * that exist in THIS snapshot count as support; a claim citing zero real
 * findings is kept but marked `unsupported` (the hallucination flag). When no
 * claims were supplied, one grounded claim is derived per finding so the policy
 * is never ungrounded by default.
 */
function buildClaims(
  versionId: string,
  organizationId: string,
  findings: SnapshotFinding[],
  provided: ProvidedClaim[],
): PolicyClaim[] {
  const byId = new Map(findings.map((f) => [f.findingId, f]));

  const makeClaim = (
    statement: string,
    controlId: string | null,
    citedIds: string[],
  ): PolicyClaim => {
    const grounded = citedIds.filter((id) => byId.has(id));
    const resourceArns: string[] = [];
    let observedAt: string | null = null;
    for (const id of grounded) {
      const f = byId.get(id)!;
      if (f.resourceArn && !resourceArns.includes(f.resourceArn)) resourceArns.push(f.resourceArn);
      if (f.observedAt && (!observedAt || f.observedAt > observedAt)) observedAt = f.observedAt;
    }
    const resolvedControl =
      controlId ?? (grounded.length > 0 ? byId.get(grounded[0])!.controlIds[0] ?? null : null);
    return {
      id: randomUUID(),
      policy_version_id: versionId,
      organization_id: organizationId,
      control_id: resolvedControl,
      statement,
      finding_ids: grounded,
      resource_arns: resourceArns,
      support_status: grounded.length > 0 && resolvedControl ? "supported" : "unsupported",
      observed_at: observedAt,
    };
  };

  if (provided.length > 0) {
    return provided.map((c) => makeClaim(c.statement, c.controlId, c.findingIds));
  }

  return findings.map((f) =>
    makeClaim(
      `Observed control evidence: ${f.summary}`,
      f.controlIds[0] ?? null,
      [f.findingId],
    ),
  );
}

/**
 * Render the human-readable policy body (Markdown). Every control section
 * lists its grounded claims with the citing finding ids + resource ARNs so an
 * auditor can trace each statement back to observed evidence. Unsupported
 * claims are called out in a dedicated "Requires human review" section.
 */
function renderPolicyMarkdown(
  title: string,
  controlIndex: Map<string, SnapshotFinding[]>,
  claims: PolicyClaim[],
): string {
  const claimsByControl = new Map<string, PolicyClaim[]>();
  for (const claim of claims) {
    const key = claim.control_id ?? "__unmapped__";
    const bucket = claimsByControl.get(key);
    if (bucket) bucket.push(claim);
    else claimsByControl.set(key, [claim]);
  }

  const lines: string[] = [`# ${title}`, ""];
  lines.push(
    "> Draft generated from snapshot evidence. Every statement below cites the",
    "> finding id(s) it is grounded in; statements with no supporting finding are",
    "> flagged for human review before this version may be approved.",
    "",
  );

  for (const [controlId] of controlIndex) {
    if (controlId === "__unmapped__") continue;
    lines.push(`## Control ${controlId}`, "");
    const controlClaims = claimsByControl.get(controlId) ?? [];
    if (controlClaims.length === 0) {
      lines.push("_No grounded claims for this control yet._", "");
      continue;
    }
    for (const claim of controlClaims) {
      const cites = claim.finding_ids.length > 0 ? claim.finding_ids.join(", ") : "none";
      lines.push(`- ${claim.statement}`);
      lines.push(`  - Evidence: ${cites}`);
      if (claim.resource_arns.length > 0) {
        lines.push(`  - Resources: ${claim.resource_arns.join(", ")}`);
      }
    }
    lines.push("");
  }

  const unsupported = claims.filter((c) => c.support_status === "unsupported");
  if (unsupported.length > 0) {
    lines.push("## Requires human review", "");
    lines.push(
      "The following statements could not be grounded in a snapshot finding and",
      "a linked control, and must be verified or removed by a reviewer:",
      "",
    );
    for (const claim of unsupported) {
      lines.push(`- ${claim.statement}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export async function handleDraftPolicyFromSnapshot(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  try {
    // 1 ─ Resolve + validate required arguments (tolerant of arg casing).
    const organizationId = pick(args, "organization_id", "organizationId", "org_id", "orgId");
    const snapshotId = pick(args, "snapshot_id", "snapshotId", "soc2_snapshot_id");
    const policyTemplateId = pick(args, "policy_template_id", "policyTemplateId", "template_id");
    const policyKey = pick(args, "policy_key", "policyKey");

    const missing: string[] = [];
    if (!organizationId) missing.push("organization_id");
    if (!snapshotId) missing.push("snapshot_id");
    if (!policyTemplateId && !policyKey) missing.push("policy_template_id|policy_key");
    if (missing.length > 0) {
      return {
        status: 400,
        body: `draft_policy_from_snapshot: missing required arguments: ${missing.join(", ")}`,
      };
    }

    // 2 ─ Normalize the inline-analysis payload (findings + any draft claims).
    const findings = normalizeFindings(args.findings ?? args.snapshot_findings);
    if (findings.length === 0) {
      return {
        status: 422,
        body:
          "draft_policy_from_snapshot: snapshot has no findings to ground a policy in; " +
          "run the snapshot collection before drafting.",
      };
    }
    const providedClaims = normalizeProvidedClaims(args.claims ?? args.draft_claims);

    // 3 ─ Deterministic finding → control retrieval + grounded claim assembly.
    const controlIndex = buildControlIndex(findings);
    const versionId = randomUUID();
    const claims = buildClaims(versionId, organizationId!, findings, providedClaims);
    const supportedCount = claims.filter((c) => c.support_status === "supported").length;
    const unsupportedCount = claims.length - supportedCount;

    // 4 ─ Assemble the durable soc2_policy_versions row.
    const title =
      pick(args, "policy_title", "policyTitle", "title") ??
      (policyKey ? `${policyKey} Policy` : "SOC 2 Policy");
    const priorVersion = asInt(args.base_version_number ?? args.prior_version_number) ?? 0;
    const explicitVersion = asInt(args.version_number ?? args.versionNumber);
    const versionNumber = explicitVersion ?? priorVersion + 1;
    const requestedBy = pick(args, "requested_by", "requestedBy", "reviewer_id");
    const isRegeneration = priorVersion > 0 || Boolean(asString(args.regeneration_reason));

    const version: PolicyVersion = {
      id: versionId,
      organization_id: organizationId!,
      snapshot_id: snapshotId!,
      policy_template_id: policyTemplateId,
      policy_key: policyKey,
      title,
      version_number: versionNumber,
      // human_review autonomy: a freshly drafted version is NEVER auto-approved.
      status: unsupportedCount > 0 ? "needs_changes" : "pending_review",
      body_markdown: renderPolicyMarkdown(title, controlIndex, claims),
      claim_count: claims.length,
      supported_count: supportedCount,
      unsupported_count: unsupportedCount,
      source: isRegeneration ? "regeneration" : "snapshot",
      requested_by: requestedBy,
      generated_by: "agent:draft_policy_from_snapshot",
      generated_at: new Date().toISOString(),
    };

    // 5 ─ Emit a domain event so the operator review queue + weekly digest can
    //     react. The EventBus contract is fire-and-forget; never let it throw.
    try {
      await ctx.events.publish("soc2.policy_version.drafted", {
        policy_version_id: version.id,
        organization_id: version.organization_id,
        snapshot_id: version.snapshot_id,
        policy_template_id: version.policy_template_id,
        policy_key: version.policy_key,
        version_number: version.version_number,
        status: version.status,
        claim_count: version.claim_count,
        supported_count: version.supported_count,
        unsupported_count: version.unsupported_count,
        source: version.source,
      });
    } catch (eventErr) {
      console.warn(
        JSON.stringify({
          evt: "soc2.policy_version.event_publish_failed",
          policy_version_id: version.id,
          error: String((eventErr as Error).message),
        }),
      );
    }

    // 6 ─ Structured log (no bare console.log) for the operator audit trail.
    console.info(
      JSON.stringify({
        evt: "soc2.draft_policy_from_snapshot.completed",
        policy_version_id: version.id,
        organization_id: version.organization_id,
        snapshot_id: version.snapshot_id,
        policy_key: version.policy_key,
        version_number: version.version_number,
        status: version.status,
        claim_count: version.claim_count,
        unsupported_count: version.unsupported_count,
      }),
    );

    // 7 ─ Return the completed mutation. The approved-actions bridge reports
    //     this body back to the runtime ledger, which persists the version +
    //     claims into soc2_policy_versions / soc2_policy_claims (the soc2 schema
    //     writer owns that DDL in packages/db/company/soc2.ts) and routes the
    //     version into the human-review queue.
    return {
      status: 201,
      body: {
        ok: true,
        tool: "draft_policy_from_snapshot",
        autonomy: "human_review",
        requires_human_review: true,
        policy_version: version as unknown as Record<string, unknown>,
        claims: claims as unknown as Record<string, unknown>[],
        summary: {
          control_sections: [...controlIndex.keys()].filter((k) => k !== "__unmapped__").length,
          claim_count: claims.length,
          supported_count: supportedCount,
          unsupported_count: unsupportedCount,
        },
      },
    };
  } catch (err) {
    const message = String((err as Error).message ?? err);
    console.error(
      JSON.stringify({ evt: "soc2.draft_policy_from_snapshot.error", error: message }),
    );
    return { status: 500, body: `draft_policy_from_snapshot failed: ${message}` };
  }
}
