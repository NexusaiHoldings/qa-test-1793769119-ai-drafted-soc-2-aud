/**
 * Per-service AWS read-only collectors (F1-002).
 *
 * Each collector assumes the customer's read-only role (via assume-role.ts) and
 * gathers the configuration the SOC 2 controls care about, normalizing every
 * observation into a Finding. Collectors FAIL SOFT: a denied/failed AWS call is
 * caught, the exact IAM action is recorded on the result, and the snapshot is
 * marked visibly partial rather than aborting the whole run. This is a direct
 * response to feasibility_analysis: "heterogeneous customer environments ...
 * create integration edge cases."
 *
 * All AWS SDK access is lazy (loadAwsModule / makeServiceClient) so the Next
 * build never hard-resolves the SDK.
 */

import type { AwsCredentials } from "../assume-role";
import { loadAwsModule, makeServiceClient } from "../assume-role";

export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type FindingStatus = "pass" | "fail" | "warning" | "error";

export interface Finding {
  service: string;
  checkId: string;
  resourceId?: string;
  resourceArn?: string;
  severity: Severity;
  status: FindingStatus;
  title: string;
  detail?: string;
  raw?: Record<string, unknown>;
}

export interface CollectorResult {
  service: string;
  ok: boolean;
  findings: Finding[];
  raw: Record<string, unknown>;
  /** The IAM action that failed, when the collector tripped on a permission. */
  failingAction?: string;
  error?: string;
}

export type Collector = (
  creds: AwsCredentials,
  region: string,
) => Promise<CollectorResult>;

/** Build a Finding with sane defaults. */
function finding(f: Finding): Finding {
  return f;
}

/**
 * Load a set of command constructors from an AWS SDK v3 client module.
 * Returns a typed-ish map keyed by command name.
 */
function loadCommands(
  moduleName: string,
  names: readonly string[],
): Record<string, new (input: Record<string, unknown>) => unknown> {
  const mod = loadAwsModule<Record<string, new (input: Record<string, unknown>) => unknown>>(
    moduleName,
  );
  const out: Record<string, new (input: Record<string, unknown>) => unknown> = {};
  for (const n of names) {
    if (!mod[n]) throw new Error(`${n} missing from ${moduleName}`);
    out[n] = mod[n];
  }
  return out;
}

/** Minimal shape of an AWS SDK v3 client. */
interface AwsClient {
  send: (command: unknown) => Promise<unknown>;
}

/**
 * Wrap a block so that any AWS failure becomes a partial CollectorResult that
 * names the failing action, instead of throwing. Used by every collector.
 */
function softFail(
  service: string,
  action: string,
  error: unknown,
  partial: Partial<CollectorResult>,
): CollectorResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    service,
    ok: false,
    findings: partial.findings ?? [],
    raw: partial.raw ?? {},
    failingAction: action,
    error: `${action}: ${message}`,
  };
}

// ── collectors appended below ──

const DAY_MS = 24 * 60 * 60 * 1000;

function ageInDays(since: string | Date | undefined): number | null {
  if (!since) return null;
  const t = typeof since === "string" ? Date.parse(since) : since.getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
}

/**
 * IAM collector — users, MFA, access-key age, account password policy.
 */
export const collectIam: Collector = async (creds, region) => {
  const service = "iam";
  const findings: Finding[] = [];
  const raw: Record<string, unknown> = { users: [], password_policy: null };

  let client: AwsClient;
  let cmds: Record<string, new (input: Record<string, unknown>) => unknown>;
  try {
    client = makeServiceClient<AwsClient>("@aws-sdk/client-iam", "IAMClient", creds, region);
    cmds = loadCommands("@aws-sdk/client-iam", [
      "ListUsersCommand",
      "ListMFADevicesCommand",
      "ListAccessKeysCommand",
      "GetAccountPasswordPolicyCommand",
    ]);
  } catch (e) {
    return softFail(service, "iam:ListUsers", e, { findings, raw });
  }

  // Users + MFA + access-key age
  const users: Array<Record<string, unknown>> = [];
  try {
    let marker: string | undefined;
    let guard = 0;
    do {
      const page = (await client.send(
        new cmds.ListUsersCommand(marker ? { Marker: marker } : {}),
      )) as { Users?: Array<Record<string, unknown>>; Marker?: string; IsTruncated?: boolean };
      for (const u of page.Users ?? []) users.push(u);
      marker = page.IsTruncated ? page.Marker : undefined;
    } while (marker && ++guard < 50);
  } catch (e) {
    return softFail(service, "iam:ListUsers", e, { findings, raw });
  }

  for (const u of users) {
    const userName = String(u.UserName ?? "");
    const userArn = u.Arn ? String(u.Arn) : undefined;
    (raw.users as unknown[]).push({ UserName: userName, Arn: userArn, CreateDate: u.CreateDate });

    // MFA
    try {
      const mfa = (await client.send(
        new cmds.ListMFADevicesCommand({ UserName: userName }),
      )) as { MFADevices?: unknown[] };
      const hasMfa = (mfa.MFADevices ?? []).length > 0;
      findings.push(
        finding({
          service,
          checkId: "iam_user_mfa_enabled",
          resourceId: userName,
          resourceArn: userArn,
          severity: hasMfa ? "info" : "high",
          status: hasMfa ? "pass" : "fail",
          title: hasMfa ? `MFA enabled for ${userName}` : `MFA missing for ${userName}`,
          detail: hasMfa
            ? undefined
            : "IAM user has no MFA device; SOC 2 CC6.1 requires MFA on console users.",
        }),
      );
    } catch (e) {
      return softFail(service, "iam:ListMFADevices", e, { findings, raw });
    }

    // Access-key age
    try {
      const keys = (await client.send(
        new cmds.ListAccessKeysCommand({ UserName: userName }),
      )) as { AccessKeyMetadata?: Array<Record<string, unknown>> };
      for (const k of keys.AccessKeyMetadata ?? []) {
        const age = ageInDays(k.CreateDate as string | Date | undefined);
        const stale = age !== null && age > 90 && k.Status === "Active";
        findings.push(
          finding({
            service,
            checkId: "iam_access_key_age",
            resourceId: String(k.AccessKeyId ?? ""),
            resourceArn: userArn,
            severity: stale ? "medium" : "info",
            status: stale ? "fail" : "pass",
            title: stale
              ? `Access key for ${userName} is ${age} days old`
              : `Access key for ${userName} within rotation window`,
            detail: stale
              ? "Active access key older than 90 days; rotate per CC6.1."
              : undefined,
            raw: { age_days: age, status: k.Status },
          }),
        );
      }
    } catch (e) {
      return softFail(service, "iam:ListAccessKeys", e, { findings, raw });
    }
  }

  // Password policy
  try {
    const pol = (await client.send(new cmds.GetAccountPasswordPolicyCommand({}))) as {
      PasswordPolicy?: Record<string, unknown>;
    };
    const p = pol.PasswordPolicy ?? {};
    raw.password_policy = p;
    const minLen = Number(p.MinimumPasswordLength ?? 0);
    const weak = minLen < 14;
    findings.push(
      finding({
        service,
        checkId: "iam_password_policy_strength",
        resourceId: "account-password-policy",
        severity: weak ? "medium" : "info",
        status: weak ? "fail" : "pass",
        title: weak
          ? `Password policy minimum length is ${minLen}`
          : "Password policy meets minimum length",
        detail: weak ? "Minimum password length below 14 characters (CC6.1)." : undefined,
        raw: p,
      }),
    );
  } catch (e) {
    // NoSuchEntity means no policy at all — that is itself a finding, not a crash.
    const msg = e instanceof Error ? e.message : String(e);
    if (/NoSuchEntity|not found/i.test(msg)) {
      findings.push(
        finding({
          service,
          checkId: "iam_password_policy_strength",
          resourceId: "account-password-policy",
          severity: "high",
          status: "fail",
          title: "No account password policy configured",
          detail: "Account has no IAM password policy (CC6.1).",
        }),
      );
    } else {
      return softFail(service, "iam:GetAccountPasswordPolicy", e, { findings, raw });
    }
  }

  return { service, ok: true, findings, raw };
};

/**
 * S3 collector — public-access block, default encryption, access logging.
 */
export const collectS3: Collector = async (creds, region) => {
  const service = "s3";
  const findings: Finding[] = [];
  const raw: Record<string, unknown> = { buckets: [] };

  let client: AwsClient;
  let cmds: Record<string, new (input: Record<string, unknown>) => unknown>;
  try {
    client = makeServiceClient<AwsClient>("@aws-sdk/client-s3", "S3Client", creds, region);
    cmds = loadCommands("@aws-sdk/client-s3", [
      "ListBucketsCommand",
      "GetPublicAccessBlockCommand",
      "GetBucketEncryptionCommand",
      "GetBucketLoggingCommand",
    ]);
  } catch (e) {
    return softFail(service, "s3:ListAllMyBuckets", e, { findings, raw });
  }

  let buckets: Array<Record<string, unknown>> = [];
  try {
    const page = (await client.send(new cmds.ListBucketsCommand({}))) as {
      Buckets?: Array<Record<string, unknown>>;
    };
    buckets = page.Buckets ?? [];
  } catch (e) {
    return softFail(service, "s3:ListAllMyBuckets", e, { findings, raw });
  }

  for (const b of buckets) {
    const name = String(b.Name ?? "");
    const arn = `arn:aws:s3:::${name}`;
    (raw.buckets as unknown[]).push({ Name: name });

    // Public access block
    try {
      const pab = (await client.send(
        new cmds.GetPublicAccessBlockCommand({ Bucket: name }),
      )) as { PublicAccessBlockConfiguration?: Record<string, boolean> };
      const c = pab.PublicAccessBlockConfiguration ?? {};
      const blocked =
        c.BlockPublicAcls && c.BlockPublicPolicy && c.IgnorePublicAcls && c.RestrictPublicBuckets;
      findings.push(
        finding({
          service,
          checkId: "s3_public_access_block",
          resourceId: name,
          resourceArn: arn,
          severity: blocked ? "info" : "high",
          status: blocked ? "pass" : "fail",
          title: blocked
            ? `Public access fully blocked on ${name}`
            : `Public access NOT fully blocked on ${name}`,
          detail: blocked ? undefined : "Enable all four S3 Block Public Access settings (CC6.1).",
          raw: c,
        }),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/NoSuchPublicAccessBlockConfiguration/i.test(msg)) {
        findings.push(
          finding({
            service,
            checkId: "s3_public_access_block",
            resourceId: name,
            resourceArn: arn,
            severity: "high",
            status: "fail",
            title: `No public access block on ${name}`,
            detail: "Bucket has no Block Public Access configuration (CC6.1).",
          }),
        );
      } else {
        return softFail(service, "s3:GetBucketPublicAccessBlock", e, { findings, raw });
      }
    }

    // Default encryption
    try {
      const enc = (await client.send(
        new cmds.GetBucketEncryptionCommand({ Bucket: name }),
      )) as { ServerSideEncryptionConfiguration?: Record<string, unknown> };
      const rules = (enc.ServerSideEncryptionConfiguration as { Rules?: unknown[] } | undefined)
        ?.Rules;
      const encrypted = Array.isArray(rules) && rules.length > 0;
      findings.push(
        finding({
          service,
          checkId: "s3_default_encryption",
          resourceId: name,
          resourceArn: arn,
          severity: encrypted ? "info" : "medium",
          status: encrypted ? "pass" : "fail",
          title: encrypted
            ? `Default encryption enabled on ${name}`
            : `Default encryption missing on ${name}`,
          detail: encrypted ? undefined : "Enable default SSE on the bucket (CC6.7).",
        }),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/ServerSideEncryptionConfigurationNotFoundError/i.test(msg)) {
        findings.push(
          finding({
            service,
            checkId: "s3_default_encryption",
            resourceId: name,
            resourceArn: arn,
            severity: "medium",
            status: "fail",
            title: `Default encryption missing on ${name}`,
            detail: "Bucket has no default encryption configuration (CC6.7).",
          }),
        );
      } else {
        return softFail(service, "s3:GetEncryptionConfiguration", e, { findings, raw });
      }
    }

    // Access logging
    try {
      const log = (await client.send(
        new cmds.GetBucketLoggingCommand({ Bucket: name }),
      )) as { LoggingEnabled?: Record<string, unknown> };
      const enabled = !!log.LoggingEnabled;
      findings.push(
        finding({
          service,
          checkId: "s3_access_logging",
          resourceId: name,
          resourceArn: arn,
          severity: enabled ? "info" : "low",
          status: enabled ? "pass" : "warning",
          title: enabled
            ? `Access logging enabled on ${name}`
            : `Access logging disabled on ${name}`,
          detail: enabled ? undefined : "Enable server access logging (CC7.2).",
        }),
      );
    } catch (e) {
      return softFail(service, "s3:GetBucketLogging", e, { findings, raw });
    }
  }

  return { service, ok: true, findings, raw };
};

/**
 * CloudTrail collector — multi-region coverage + log-file validation.
 */
export const collectCloudTrail: Collector = async (creds, region) => {
  const service = "cloudtrail";
  const findings: Finding[] = [];
  const raw: Record<string, unknown> = { trails: [] };

  let client: AwsClient;
  let cmds: Record<string, new (input: Record<string, unknown>) => unknown>;
  try {
    client = makeServiceClient<AwsClient>(
      "@aws-sdk/client-cloudtrail",
      "CloudTrailClient",
      creds,
      region,
    );
    cmds = loadCommands("@aws-sdk/client-cloudtrail", ["DescribeTrailsCommand"]);
  } catch (e) {
    return softFail(service, "cloudtrail:DescribeTrails", e, { findings, raw });
  }

  let trails: Array<Record<string, unknown>> = [];
  try {
    const page = (await client.send(new cmds.DescribeTrailsCommand({}))) as {
      trailList?: Array<Record<string, unknown>>;
    };
    trails = page.trailList ?? [];
  } catch (e) {
    return softFail(service, "cloudtrail:DescribeTrails", e, { findings, raw });
  }

  if (trails.length === 0) {
    findings.push(
      finding({
        service,
        checkId: "cloudtrail_enabled",
        resourceId: "account",
        severity: "high",
        status: "fail",
        title: "No CloudTrail trails configured",
        detail: "At least one multi-region trail is required (CC7.2).",
      }),
    );
    return { service, ok: true, findings, raw };
  }

  const multiRegion = trails.some((t) => t.IsMultiRegionTrail === true);
  findings.push(
    finding({
      service,
      checkId: "cloudtrail_multi_region",
      resourceId: "account",
      severity: multiRegion ? "info" : "high",
      status: multiRegion ? "pass" : "fail",
      title: multiRegion
        ? "A multi-region CloudTrail trail exists"
        : "No multi-region CloudTrail trail",
      detail: multiRegion ? undefined : "Enable a multi-region trail (CC7.2).",
    }),
  );

  for (const t of trails) {
    const name = String(t.Name ?? "");
    (raw.trails as unknown[]).push({ Name: name, IsMultiRegionTrail: t.IsMultiRegionTrail });
    const validated = t.LogFileValidationEnabled === true;
    findings.push(
      finding({
        service,
        checkId: "cloudtrail_log_file_validation",
        resourceId: name,
        resourceArn: t.TrailARN ? String(t.TrailARN) : undefined,
        severity: validated ? "info" : "medium",
        status: validated ? "pass" : "fail",
        title: validated
          ? `Log-file validation enabled on ${name}`
          : `Log-file validation disabled on ${name}`,
        detail: validated ? undefined : "Enable log-file integrity validation (CC7.2).",
      }),
    );
  }

  return { service, ok: true, findings, raw };
};

/**
 * AWS Config collector — a recorder must exist AND be recording.
 */
export const collectConfig: Collector = async (creds, region) => {
  const service = "config";
  const findings: Finding[] = [];
  const raw: Record<string, unknown> = { recorders: [], status: [] };

  let client: AwsClient;
  let cmds: Record<string, new (input: Record<string, unknown>) => unknown>;
  try {
    client = makeServiceClient<AwsClient>(
      "@aws-sdk/client-config-service",
      "ConfigServiceClient",
      creds,
      region,
    );
    cmds = loadCommands("@aws-sdk/client-config-service", [
      "DescribeConfigurationRecordersCommand",
      "DescribeConfigurationRecorderStatusCommand",
    ]);
  } catch (e) {
    return softFail(service, "config:DescribeConfigurationRecorders", e, { findings, raw });
  }

  let recorders: Array<Record<string, unknown>> = [];
  try {
    const page = (await client.send(new cmds.DescribeConfigurationRecordersCommand({}))) as {
      ConfigurationRecorders?: Array<Record<string, unknown>>;
    };
    recorders = page.ConfigurationRecorders ?? [];
    raw.recorders = recorders;
  } catch (e) {
    return softFail(service, "config:DescribeConfigurationRecorders", e, { findings, raw });
  }

  if (recorders.length === 0) {
    findings.push(
      finding({
        service,
        checkId: "config_recorder_enabled",
        resourceId: "account",
        severity: "high",
        status: "fail",
        title: "No AWS Config recorder configured",
        detail: "Enable an AWS Config recorder for change tracking (CC7.1).",
      }),
    );
    return { service, ok: true, findings, raw };
  }

  let statuses: Array<Record<string, unknown>> = [];
  try {
    const page = (await client.send(
      new cmds.DescribeConfigurationRecorderStatusCommand({}),
    )) as { ConfigurationRecordersStatus?: Array<Record<string, unknown>> };
    statuses = page.ConfigurationRecordersStatus ?? [];
    raw.status = statuses;
  } catch (e) {
    return softFail(service, "config:DescribeConfigurationRecorderStatus", e, { findings, raw });
  }

  const recording = statuses.some((s) => s.recording === true);
  findings.push(
    finding({
      service,
      checkId: "config_recorder_enabled",
      resourceId: String(recorders[0]?.name ?? "default"),
      severity: recording ? "info" : "high",
      status: recording ? "pass" : "fail",
      title: recording ? "AWS Config recorder is recording" : "AWS Config recorder NOT recording",
      detail: recording ? undefined : "Config recorder exists but is stopped (CC7.1).",
    }),
  );

  return { service, ok: true, findings, raw };
};

/**
 * GuardDuty collector — at least one enabled detector in the region.
 */
export const collectGuardDuty: Collector = async (creds, region) => {
  const service = "guardduty";
  const findings: Finding[] = [];
  const raw: Record<string, unknown> = { detectors: [] };

  let client: AwsClient;
  let cmds: Record<string, new (input: Record<string, unknown>) => unknown>;
  try {
    client = makeServiceClient<AwsClient>(
      "@aws-sdk/client-guardduty",
      "GuardDutyClient",
      creds,
      region,
    );
    cmds = loadCommands("@aws-sdk/client-guardduty", [
      "ListDetectorsCommand",
      "GetDetectorCommand",
    ]);
  } catch (e) {
    return softFail(service, "guardduty:ListDetectors", e, { findings, raw });
  }

  let detectorIds: string[] = [];
  try {
    const page = (await client.send(new cmds.ListDetectorsCommand({}))) as {
      DetectorIds?: string[];
    };
    detectorIds = page.DetectorIds ?? [];
    raw.detectors = detectorIds;
  } catch (e) {
    return softFail(service, "guardduty:ListDetectors", e, { findings, raw });
  }

  if (detectorIds.length === 0) {
    findings.push(
      finding({
        service,
        checkId: "guardduty_enabled",
        resourceId: "account",
        severity: "medium",
        status: "fail",
        title: "GuardDuty not enabled",
        detail: "Enable GuardDuty threat detection (CC7.2).",
      }),
    );
    return { service, ok: true, findings, raw };
  }

  for (const id of detectorIds) {
    try {
      const d = (await client.send(new cmds.GetDetectorCommand({ DetectorId: id }))) as {
        Status?: string;
      };
      const enabled = d.Status === "ENABLED";
      findings.push(
        finding({
          service,
          checkId: "guardduty_enabled",
          resourceId: id,
          severity: enabled ? "info" : "medium",
          status: enabled ? "pass" : "fail",
          title: enabled ? `GuardDuty detector ${id} enabled` : `GuardDuty detector ${id} disabled`,
          detail: enabled ? undefined : "Detector exists but is suspended (CC7.2).",
        }),
      );
    } catch (e) {
      return softFail(service, "guardduty:GetDetector", e, { findings, raw });
    }
  }

  return { service, ok: true, findings, raw };
};

/**
 * KMS collector — customer-managed key rotation enabled.
 */
export const collectKms: Collector = async (creds, region) => {
  const service = "kms";
  const findings: Finding[] = [];
  const raw: Record<string, unknown> = { keys: [] };

  let client: AwsClient;
  let cmds: Record<string, new (input: Record<string, unknown>) => unknown>;
  try {
    client = makeServiceClient<AwsClient>("@aws-sdk/client-kms", "KMSClient", creds, region);
    cmds = loadCommands("@aws-sdk/client-kms", [
      "ListKeysCommand",
      "DescribeKeyCommand",
      "GetKeyRotationStatusCommand",
    ]);
  } catch (e) {
    return softFail(service, "kms:ListKeys", e, { findings, raw });
  }

  const keys: Array<Record<string, unknown>> = [];
  try {
    let marker: string | undefined;
    let guard = 0;
    do {
      const page = (await client.send(
        new cmds.ListKeysCommand(marker ? { Marker: marker } : {}),
      )) as { Keys?: Array<Record<string, unknown>>; NextMarker?: string; Truncated?: boolean };
      for (const k of page.Keys ?? []) keys.push(k);
      marker = page.Truncated ? page.NextMarker : undefined;
    } while (marker && ++guard < 50);
  } catch (e) {
    return softFail(service, "kms:ListKeys", e, { findings, raw });
  }

  for (const k of keys) {
    const keyId = String(k.KeyId ?? "");
    const keyArn = k.KeyArn ? String(k.KeyArn) : undefined;

    // Only customer-managed, enabled keys support rotation checks.
    let meta: { KeyManager?: string; KeyState?: string } = {};
    try {
      const d = (await client.send(new cmds.DescribeKeyCommand({ KeyId: keyId }))) as {
        KeyMetadata?: { KeyManager?: string; KeyState?: string };
      };
      meta = d.KeyMetadata ?? {};
    } catch (e) {
      return softFail(service, "kms:DescribeKey", e, { findings, raw });
    }
    if (meta.KeyManager !== "CUSTOMER" || meta.KeyState !== "Enabled") continue;
    (raw.keys as unknown[]).push({ KeyId: keyId });

    try {
      const rot = (await client.send(new cmds.GetKeyRotationStatusCommand({ KeyId: keyId }))) as {
        KeyRotationEnabled?: boolean;
      };
      const enabled = rot.KeyRotationEnabled === true;
      findings.push(
        finding({
          service,
          checkId: "kms_key_rotation",
          resourceId: keyId,
          resourceArn: keyArn,
          severity: enabled ? "info" : "medium",
          status: enabled ? "pass" : "fail",
          title: enabled
            ? `Key rotation enabled for ${keyId}`
            : `Key rotation disabled for ${keyId}`,
          detail: enabled ? undefined : "Enable annual rotation on customer-managed keys (CC6.7).",
        }),
      );
    } catch (e) {
      return softFail(service, "kms:GetKeyRotationStatus", e, { findings, raw });
    }
  }

  return { service, ok: true, findings, raw };
};

/**
 * Security Groups collector — any 0.0.0.0/0 (or ::/0) ingress rule is flagged.
 */
export const collectSecurityGroups: Collector = async (creds, region) => {
  const service = "securitygroups";
  const findings: Finding[] = [];
  const raw: Record<string, unknown> = { groups: [] };

  let client: AwsClient;
  let cmds: Record<string, new (input: Record<string, unknown>) => unknown>;
  try {
    client = makeServiceClient<AwsClient>("@aws-sdk/client-ec2", "EC2Client", creds, region);
    cmds = loadCommands("@aws-sdk/client-ec2", ["DescribeSecurityGroupsCommand"]);
  } catch (e) {
    return softFail(service, "ec2:DescribeSecurityGroups", e, { findings, raw });
  }

  const groups: Array<Record<string, unknown>> = [];
  try {
    let token: string | undefined;
    let guard = 0;
    do {
      const page = (await client.send(
        new cmds.DescribeSecurityGroupsCommand(token ? { NextToken: token } : {}),
      )) as { SecurityGroups?: Array<Record<string, unknown>>; NextToken?: string };
      for (const g of page.SecurityGroups ?? []) groups.push(g);
      token = page.NextToken;
    } while (token && ++guard < 50);
  } catch (e) {
    return softFail(service, "ec2:DescribeSecurityGroups", e, { findings, raw });
  }

  for (const g of groups) {
    const groupId = String(g.GroupId ?? "");
    (raw.groups as unknown[]).push({ GroupId: groupId, GroupName: g.GroupName });
    const perms = (g.IpPermissions as Array<Record<string, unknown>> | undefined) ?? [];
    const openRules: string[] = [];
    for (const p of perms) {
      const ranges = (p.IpRanges as Array<{ CidrIp?: string }> | undefined) ?? [];
      const v6 = (p.Ipv6Ranges as Array<{ CidrIpv6?: string }> | undefined) ?? [];
      const fromPort = p.FromPort === undefined ? "all" : String(p.FromPort);
      if (ranges.some((r) => r.CidrIp === "0.0.0.0/0") || v6.some((r) => r.CidrIpv6 === "::/0")) {
        openRules.push(`${p.IpProtocol ?? "all"}:${fromPort}`);
      }
    }
    const open = openRules.length > 0;
    findings.push(
      finding({
        service,
        checkId: "sg_open_ingress",
        resourceId: groupId,
        severity: open ? "high" : "info",
        status: open ? "fail" : "pass",
        title: open
          ? `Security group ${groupId} allows 0.0.0.0/0 ingress`
          : `Security group ${groupId} has no open ingress`,
        detail: open
          ? `Open ingress rules: ${openRules.join(", ")} — restrict source ranges (CC6.6).`
          : undefined,
        raw: { openRules },
      }),
    );
  }

  return { service, ok: true, findings, raw };
};

/**
 * RDS collector — storage encryption, public accessibility, backup retention.
 */
export const collectRds: Collector = async (creds, region) => {
  const service = "rds";
  const findings: Finding[] = [];
  const raw: Record<string, unknown> = { instances: [] };

  let client: AwsClient;
  let cmds: Record<string, new (input: Record<string, unknown>) => unknown>;
  try {
    client = makeServiceClient<AwsClient>("@aws-sdk/client-rds", "RDSClient", creds, region);
    cmds = loadCommands("@aws-sdk/client-rds", ["DescribeDBInstancesCommand"]);
  } catch (e) {
    return softFail(service, "rds:DescribeDBInstances", e, { findings, raw });
  }

  const instances: Array<Record<string, unknown>> = [];
  try {
    let marker: string | undefined;
    let guard = 0;
    do {
      const page = (await client.send(
        new cmds.DescribeDBInstancesCommand(marker ? { Marker: marker } : {}),
      )) as { DBInstances?: Array<Record<string, unknown>>; Marker?: string };
      for (const i of page.DBInstances ?? []) instances.push(i);
      marker = page.Marker;
    } while (marker && ++guard < 50);
  } catch (e) {
    return softFail(service, "rds:DescribeDBInstances", e, { findings, raw });
  }

  for (const i of instances) {
    const id = String(i.DBInstanceIdentifier ?? "");
    const arn = i.DBInstanceArn ? String(i.DBInstanceArn) : undefined;
    (raw.instances as unknown[]).push({ DBInstanceIdentifier: id });

    const encrypted = i.StorageEncrypted === true;
    findings.push(
      finding({
        service,
        checkId: "rds_storage_encrypted",
        resourceId: id,
        resourceArn: arn,
        severity: encrypted ? "info" : "high",
        status: encrypted ? "pass" : "fail",
        title: encrypted ? `RDS ${id} storage encrypted` : `RDS ${id} storage NOT encrypted`,
        detail: encrypted ? undefined : "Enable storage encryption at rest (CC6.7).",
      }),
    );

    const publicAccess = i.PubliclyAccessible === true;
    findings.push(
      finding({
        service,
        checkId: "rds_public_access",
        resourceId: id,
        resourceArn: arn,
        severity: publicAccess ? "high" : "info",
        status: publicAccess ? "fail" : "pass",
        title: publicAccess
          ? `RDS ${id} is publicly accessible`
          : `RDS ${id} is not publicly accessible`,
        detail: publicAccess ? "Disable public accessibility (CC6.6)." : undefined,
      }),
    );

    const retention = Number(i.BackupRetentionPeriod ?? 0);
    const backupsOk = retention >= 7;
    findings.push(
      finding({
        service,
        checkId: "rds_backup_retention",
        resourceId: id,
        resourceArn: arn,
        severity: backupsOk ? "info" : "medium",
        status: backupsOk ? "pass" : "fail",
        title: backupsOk
          ? `RDS ${id} backup retention ${retention} days`
          : `RDS ${id} backup retention too low (${retention} days)`,
        detail: backupsOk ? undefined : "Set backup retention to at least 7 days (A1.2).",
      }),
    );
  }

  return { service, ok: true, findings, raw };
};

/**
 * VPC flow-logs collector — every VPC should have at least one active flow log.
 */
export const collectVpcFlowLogs: Collector = async (creds, region) => {
  const service = "vpcflowlogs";
  const findings: Finding[] = [];
  const raw: Record<string, unknown> = { vpcs: [], flow_logs: [] };

  let client: AwsClient;
  let cmds: Record<string, new (input: Record<string, unknown>) => unknown>;
  try {
    client = makeServiceClient<AwsClient>("@aws-sdk/client-ec2", "EC2Client", creds, region);
    cmds = loadCommands("@aws-sdk/client-ec2", ["DescribeVpcsCommand", "DescribeFlowLogsCommand"]);
  } catch (e) {
    return softFail(service, "ec2:DescribeVpcs", e, { findings, raw });
  }

  let vpcs: Array<Record<string, unknown>> = [];
  try {
    const page = (await client.send(new cmds.DescribeVpcsCommand({}))) as {
      Vpcs?: Array<Record<string, unknown>>;
    };
    vpcs = page.Vpcs ?? [];
    raw.vpcs = vpcs.map((v) => ({ VpcId: v.VpcId }));
  } catch (e) {
    return softFail(service, "ec2:DescribeVpcs", e, { findings, raw });
  }

  let flowLogs: Array<Record<string, unknown>> = [];
  try {
    const page = (await client.send(new cmds.DescribeFlowLogsCommand({}))) as {
      FlowLogs?: Array<Record<string, unknown>>;
    };
    flowLogs = page.FlowLogs ?? [];
    raw.flow_logs = flowLogs.map((f) => ({ ResourceId: f.ResourceId, Status: f.FlowLogStatus }));
  } catch (e) {
    return softFail(service, "ec2:DescribeFlowLogs", e, { findings, raw });
  }

  const loggedVpcs = new Set(
    flowLogs
      .filter((f) => f.FlowLogStatus === "ACTIVE")
      .map((f) => String(f.ResourceId ?? "")),
  );

  for (const v of vpcs) {
    const vpcId = String(v.VpcId ?? "");
    const logged = loggedVpcs.has(vpcId);
    findings.push(
      finding({
        service,
        checkId: "vpc_flow_logs_enabled",
        resourceId: vpcId,
        severity: logged ? "info" : "medium",
        status: logged ? "pass" : "fail",
        title: logged ? `Flow logs active for ${vpcId}` : `No active flow logs for ${vpcId}`,
        detail: logged ? undefined : "Enable VPC flow logs for network monitoring (CC7.2).",
      }),
    );
  }

  return { service, ok: true, findings, raw };
};

/**
 * CloudWatch collector — at least one metric alarm is configured.
 */
export const collectCloudWatch: Collector = async (creds, region) => {
  const service = "cloudwatch";
  const findings: Finding[] = [];
  const raw: Record<string, unknown> = { alarms: [] };

  let client: AwsClient;
  let cmds: Record<string, new (input: Record<string, unknown>) => unknown>;
  try {
    client = makeServiceClient<AwsClient>(
      "@aws-sdk/client-cloudwatch",
      "CloudWatchClient",
      creds,
      region,
    );
    cmds = loadCommands("@aws-sdk/client-cloudwatch", ["DescribeAlarmsCommand"]);
  } catch (e) {
    return softFail(service, "cloudwatch:DescribeAlarms", e, { findings, raw });
  }

  const alarms: Array<Record<string, unknown>> = [];
  try {
    let token: string | undefined;
    let guard = 0;
    do {
      const page = (await client.send(
        new cmds.DescribeAlarmsCommand(token ? { NextToken: token } : {}),
      )) as { MetricAlarms?: Array<Record<string, unknown>>; NextToken?: string };
      for (const a of page.MetricAlarms ?? []) alarms.push(a);
      token = page.NextToken;
    } while (token && ++guard < 50);
  } catch (e) {
    return softFail(service, "cloudwatch:DescribeAlarms", e, { findings, raw });
  }

  raw.alarms = alarms.map((a) => ({ AlarmName: a.AlarmName }));
  const hasAlarms = alarms.length > 0;
  findings.push(
    finding({
      service,
      checkId: "cloudwatch_alarms_configured",
      resourceId: "account",
      severity: hasAlarms ? "info" : "low",
      status: hasAlarms ? "pass" : "warning",
      title: hasAlarms
        ? `${alarms.length} CloudWatch alarm(s) configured`
        : "No CloudWatch alarms configured",
      detail: hasAlarms ? undefined : "Configure CloudWatch alarms for key metrics (CC7.2).",
    }),
  );

  return { service, ok: true, findings, raw };
};

/**
 * Ordered registry of every collector, keyed by service. The job runner enqueues
 * one job per entry and processes them a chunk at a time.
 */
export const COLLECTORS: Record<string, Collector> = {
  iam: collectIam,
  s3: collectS3,
  cloudtrail: collectCloudTrail,
  config: collectConfig,
  guardduty: collectGuardDuty,
  kms: collectKms,
  securitygroups: collectSecurityGroups,
  rds: collectRds,
  vpcflowlogs: collectVpcFlowLogs,
  cloudwatch: collectCloudWatch,
};

/** Human-friendly service labels for the UI progress rows. */
export const SERVICE_LABELS: Record<string, string> = {
  iam: "IAM",
  s3: "S3",
  cloudtrail: "CloudTrail",
  config: "AWS Config",
  guardduty: "GuardDuty",
  kms: "KMS",
  securitygroups: "Security Groups",
  rds: "RDS",
  vpcflowlogs: "VPC Flow Logs",
  cloudwatch: "CloudWatch",
};

/** The canonical list of services collected, in run order. */
export const SERVICE_ORDER: readonly string[] = Object.keys(COLLECTORS);

/**
 * Run a single collector by service name. Returns a fail-soft CollectorResult if
 * the service is unknown rather than throwing.
 */
export async function runCollector(
  service: string,
  creds: AwsCredentials,
  region: string,
): Promise<CollectorResult> {
  const collector = COLLECTORS[service];
  if (!collector) {
    return {
      service,
      ok: false,
      findings: [],
      raw: {},
      error: `unknown service collector: ${service}`,
      failingAction: "unknown",
    };
  }
  try {
    return await collector(creds, region);
  } catch (e) {
    const action = (e as Error & { failingAction?: string }).failingAction || `${service}:unknown`;
    return softFail(service, action, e, {});
  }
}
