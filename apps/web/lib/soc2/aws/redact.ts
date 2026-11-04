/**
 * Redaction pass for AWS config snapshots (F1-002).
 *
 * The connector collects read-only configuration, but even "read-only" AWS
 * responses can echo back sensitive material: temporary STS tokens, access-key
 * IDs, bucket policy principals, KMS key material, tags that customers (mis)use
 * to store secrets. Per the design, snapshot JSON is persisted ONLY after this
 * deterministic redaction pass runs — nothing sensitive reaches Postgres raw.
 *
 * Pure, synchronous, dependency-free (safe to import anywhere, incl. the client
 * never — this is server-side utility code). Every function is total: it never
 * throws on malformed input, it returns a redacted copy.
 */

/** Sentinel inserted in place of a redacted value. */
export const REDACTED = "[REDACTED]";

/**
 * Key names (case-insensitive substring match) whose VALUES are always masked.
 * These cover credentials, tokens, and raw policy/material blobs that can carry
 * secrets regardless of service.
 */
const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  "secretaccesskey",
  "sessiontoken",
  "accesskeyid",
  "password",
  "privatekey",
  "keymaterial",
  "plaintext",
  "ciphertext",
  "token",
  "secret",
  "credential",
  "authorization",
  "signature",
  "passphrase",
];

/** Patterns for VALUES that look like secrets even under an innocuous key. */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  // AWS access key id (AKIA / ASIA + 16 base32 chars)
  /\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g,
  // AWS secret access key (40 char base64-ish) — redact conservatively
  /\b[A-Za-z0-9/+=]{40}\b/g,
  // Bearer / auth tokens
  /\bBearer\s+[A-Za-z0-9._-]+/gi,
  // PEM private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Mask a 12-digit AWS account id to its last 4 (e.g. "123456789012" →
 * "********9012"). Account ids are not secret per se, but we minimize exposure
 * of the customer's full account identifier in stored JSON.
 */
export function maskAccountId(accountId: string): string {
  const digits = accountId.replace(/\D/g, "");
  if (digits.length < 4) return REDACTED;
  return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

/** Apply value-pattern redaction to a single string. */
function redactString(value: string): string {
  let out = value;
  for (const re of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

/**
 * Recursively redact an arbitrary JSON-ish value. Returns a NEW structure;
 * the input is never mutated. Cyclic structures are handled via a seen-set.
 */
export function redactValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return redactString(value);

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    if (seen.has(value)) return REDACTED;
    seen.add(value);
    return value.map((item) => redactValue(item, seen));
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return REDACTED;
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(obj)) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = redactValue(v, seen);
    }
    return out;
  }

  // functions, symbols, bigint, etc. — drop to a safe string
  return REDACTED;
}

/**
 * Redact a full snapshot payload (map of service → collected data) before it is
 * persisted to soc2_config_snapshots.raw_redacted. Top-level entry point used
 * by the job runner.
 */
export function redactSnapshot(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const result = redactValue(payload) as Record<string, unknown> | typeof REDACTED;
  if (typeof result !== "object" || result === null) {
    return {};
  }
  return result as Record<string, unknown>;
}
