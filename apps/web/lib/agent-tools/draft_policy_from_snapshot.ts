import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export async function handleDraftPolicyFromSnapshot(
  _ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const organizationId =
    asString(args.organization_id) ??
    asString(args.organizationId) ??
    asString(args.org_id) ??
    asString(args.orgId);

  const snapshotId =
    asString(args.snapshot_id) ??
    asString(args.snapshotId) ??
    asString(args.soc2_snapshot_id);

  const policyTemplateId =
    asString(args.policy_template_id) ??
    asString(args.policyTemplateId) ??
    asString(args.template_id);

  const policyKey = asString(args.policy_key) ?? asString(args.policyKey);

  const missing: string[] = [];
  if (!organizationId) missing.push("organization_id");
  if (!snapshotId) missing.push("snapshot_id");
  if (!policyTemplateId && !policyKey) missing.push("policy_template_id|policy_key");

  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        code: "invalid_arguments",
        message: `Missing required arguments: ${missing.join(", ")}`,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "human_review_required",
      message:
        "draft_policy_from_snapshot is a confirm-gated mutation and must be executed through the cross-boundary bridge.",
    },
    data: {
      tool: "draft_policy_from_snapshot",
      autonomy: "human_review",
      route: "cross_boundary_bridge",
      organization_id: organizationId,
      snapshot_id: snapshotId,
      policy_template_id: policyTemplateId ?? null,
      policy_key: policyKey ?? null,
    },
  };
}
