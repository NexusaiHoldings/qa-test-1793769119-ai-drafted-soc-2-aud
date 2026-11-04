/**
 * STS AssumeRole wiring for the AWS read-only connector (F1-002).
 *
 * The customer runs a one-click CloudFormation quick-create that provisions a
 * read-only IAM role (SecurityAudit + ViewOnlyAccess) trusting the Nexus
 * trust-anchor AWS account with a per-org ExternalId. We NEVER store long-lived
 * customer keys — at collection time we call sts:AssumeRole from the anchor
 * account (Vercel OIDC federation → anchor base creds) scoped by the ExternalId,
 * receiving short-lived credentials used only for that collection pass.
 *
 * AWS SDK v3 is loaded lazily via a runtime require so the Next build never
 * hard-resolves it (the collectors fail soft if the SDK is unavailable, exactly
 * as the design requires for heterogeneous customer environments). The packages
 * are declared in apps/web/package.json for the deployed runtime.
 */

import { createHash, randomBytes } from "crypto";

/** Short-lived credentials returned by STS AssumeRole. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: string;
}

/** The subset of a soc2_connections row this module needs. */
export interface ConnectionTrust {
  id: string;
  organization_id: string;
  role_arn: string | null;
  external_id: string;
  region: string;
  aws_account_id?: string | null;
}

/** Result of a trust-verification attempt. */
export interface TrustVerification {
  ok: boolean;
  accountId?: string;
  arn?: string;
  error?: string;
  failingAction?: string;
}

/**
 * Lazily require an AWS SDK v3 client module. Uses eval("require") so neither
 * webpack nor tsc tries to resolve the package at build time; the dependency is
 * only needed when a collection actually runs on the deployed function.
 */
export function loadAwsModule<T = Record<string, unknown>>(moduleName: string): T {
  // eslint-disable-next-line no-eval
  const req = eval("require") as (id: string) => unknown;
  return req(moduleName) as T;
}

/** The Nexus trust-anchor AWS account id (read from env; never hardcoded). */
export function anchorAccountId(): string {
  return process.env.SOC2_AWS_ANCHOR_ACCOUNT_ID || process.env.AWS_ANCHOR_ACCOUNT_ID || "";
}

/** The CloudFormation template URL customers launch (S3-hosted, read-only role). */
export function roleTemplateUrl(): string {
  return (
    process.env.SOC2_AWS_CFN_TEMPLATE_URL ||
    "https://nexus-soc2-public.s3.amazonaws.com/aws-readonly-role.yaml"
  );
}

/**
 * Deterministically derive a stable, high-entropy ExternalId for an org. Stable
 * so re-visiting /connect/aws shows the same value the customer already pasted
 * into CloudFormation, high-entropy so it is unguessable (confused-deputy
 * defense). Combines the org id with a server secret via SHA-256.
 */
export function deriveExternalId(organizationId: string): string {
  const secret =
    process.env.SOC2_EXTERNAL_ID_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "nexus-soc2-external-id";
  const digest = createHash("sha256")
    .update(`${organizationId}:${secret}`)
    .digest("hex")
    .slice(0, 32);
  return `nexus-soc2-${digest}`;
}

/** A fresh random ExternalId (used if no deterministic derivation is desired). */
export function randomExternalId(): string {
  return `nexus-soc2-${randomBytes(16).toString("hex")}`;
}

/**
 * Build the one-click CloudFormation quick-create URL. The customer lands in
 * their own AWS console with the stack name, template, and parameters
 * (ExternalId + anchor account) pre-filled, and only has to click "Create".
 */
export function buildQuickCreateUrl(params: {
  externalId: string;
  region: string;
  roleName?: string;
}): string {
  const region = params.region || "us-east-1";
  const roleName = params.roleName || "NexusSoc2ReadOnly";
  const base = `https://${region}.console.aws.amazon.com/cloudformation/home`;
  const qp = new URLSearchParams({
    region,
  });
  const inner = new URLSearchParams({
    templateURL: roleTemplateUrl(),
    stackName: "nexus-soc2-readonly",
    param_ExternalId: params.externalId,
    param_AnchorAccountId: anchorAccountId(),
    param_RoleName: roleName,
  });
  return `${base}?${qp.toString()}#/stacks/quickcreate?${inner.toString()}`;
}

/**
 * Assume the customer's read-only role and return short-lived credentials.
 * Throws a descriptive Error (with .failingAction when derivable) so callers can
 * fail soft and surface the exact permission to the customer.
 */
export async function assumeRole(conn: ConnectionTrust): Promise<AwsCredentials> {
  if (!conn.role_arn) {
    const err = new Error("connection has no role_arn — complete the CloudFormation step first");
    (err as Error & { failingAction?: string }).failingAction = "sts:AssumeRole";
    throw err;
  }

  let STSClient: new (cfg: Record<string, unknown>) => { send: (cmd: unknown) => Promise<unknown> };
  let AssumeRoleCommand: new (input: Record<string, unknown>) => unknown;
  try {
    const mod = loadAwsModule<{
      STSClient: typeof STSClient;
      AssumeRoleCommand: typeof AssumeRoleCommand;
    }>("@aws-sdk/client-sts");
    STSClient = mod.STSClient;
    AssumeRoleCommand = mod.AssumeRoleCommand;
  } catch (e) {
    const err = new Error(`AWS SDK unavailable: ${(e as Error).message}`);
    (err as Error & { failingAction?: string }).failingAction = "sts:AssumeRole";
    throw err;
  }

  const client = new STSClient({ region: conn.region || "us-east-1" });
  const command = new AssumeRoleCommand({
    RoleArn: conn.role_arn,
    RoleSessionName: `nexus-soc2-${conn.organization_id.slice(0, 20)}`,
    ExternalId: conn.external_id,
    DurationSeconds: 3600,
  });

  let response: {
    Credentials?: {
      AccessKeyId?: string;
      SecretAccessKey?: string;
      SessionToken?: string;
      Expiration?: Date;
    };
  };
  try {
    response = (await client.send(command)) as typeof response;
  } catch (e) {
    const err = new Error(`sts:AssumeRole failed: ${(e as Error).message}`);
    (err as Error & { failingAction?: string }).failingAction = "sts:AssumeRole";
    throw err;
  }

  const creds = response.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    const err = new Error("sts:AssumeRole returned no credentials");
    (err as Error & { failingAction?: string }).failingAction = "sts:AssumeRole";
    throw err;
  }

  return {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
    expiration: creds.Expiration ? creds.Expiration.toISOString() : undefined,
  };
}

/**
 * Construct an AWS SDK v3 service client authenticated with assumed credentials.
 * `clientName` is the exported constructor (e.g. "IAMClient") and `moduleName`
 * the package (e.g. "@aws-sdk/client-iam").
 */
export function makeServiceClient<T>(
  moduleName: string,
  clientName: string,
  creds: AwsCredentials,
  region: string,
): T {
  const mod = loadAwsModule<Record<string, new (cfg: Record<string, unknown>) => T>>(moduleName);
  const Ctor = mod[clientName];
  if (!Ctor) {
    throw new Error(`${clientName} not found in ${moduleName}`);
  }
  return new Ctor({
    region: region || "us-east-1",
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

/**
 * Verify the trust relationship: assume the role, then call
 * sts:GetCallerIdentity to prove the credentials resolve to the customer
 * account. Returns a structured result rather than throwing so the UI can quote
 * the exact failing step.
 */
export async function verifyTrust(conn: ConnectionTrust): Promise<TrustVerification> {
  let creds: AwsCredentials;
  try {
    creds = await assumeRole(conn);
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message,
      failingAction: (e as Error & { failingAction?: string }).failingAction || "sts:AssumeRole",
    };
  }

  try {
    const mod = loadAwsModule<{
      STSClient: new (cfg: Record<string, unknown>) => { send: (cmd: unknown) => Promise<unknown> };
      GetCallerIdentityCommand: new (input: Record<string, unknown>) => unknown;
    }>("@aws-sdk/client-sts");
    const client = new mod.STSClient({
      region: conn.region || "us-east-1",
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
    });
    const identity = (await client.send(new mod.GetCallerIdentityCommand({}))) as {
      Account?: string;
      Arn?: string;
    };
    return { ok: true, accountId: identity.Account, arn: identity.Arn };
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message,
      failingAction: "sts:GetCallerIdentity",
    };
  }
}
