// FlowVault Audit MCP license verification.
//
// The free surface (paste-JSON, single-workflow n8n REST audits, status diag)
// works without a license key. Pro-gated tools (portfolio sweep, future
// rules, LLM gloss, scheduled audits) require an active Pro license.
//
// A license_key is a per-user identifier issued at flowvault.se. The MCP
// reads it from process.env.FLOWVAULT_LICENSE_KEY (piped in by Claude
// Desktop's user_config block) and verifies it against the FlowVault
// license-verify webhook. Verifications are cached for 1h and fall back to
// the last known-good state for 24h on transient errors so a flaky network
// does not lock out paying users mid-session.
//
// The verify endpoint never sees workflow JSON or n8n credentials. It only
// receives the license key and returns {valid, tier}.

const VERIFY_URL =
  process.env.FLOWVAULT_VERIFY_URL?.trim() ||
  "https://nordsym.app.n8n.cloud/webhook/flowvault-license-verify";

const FRESH_TTL_MS = 60 * 60 * 1000; // 1 hour
const STALE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours fallback on error

export type Tier = "pro" | "free";

export interface LicenseStatus {
  valid: boolean;
  tier: Tier | null;
  source: "env" | "arg" | "none";
  email_redacted?: string | null;
  checked_at?: string;
  cached: boolean;
  error?: string;
}

interface CacheEntry {
  result: { valid: boolean; tier: Tier | null; email_redacted: string | null };
  fetched_at: number;
  last_success_at: number;
}

const cache = new Map<string, CacheEntry>();

export function clearLicenseCache(): void {
  cache.clear();
}

export function readLicenseKeyFromEnv(): string | null {
  const raw = process.env.FLOWVAULT_LICENSE_KEY?.trim();
  return raw && raw.length > 0 ? raw : null;
}

export function redactLicenseKey(key: string): string {
  if (!key) return "";
  if (key.length <= 10) return "flv_***";
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

function looksLikeKey(key: string): boolean {
  // flv_<22+ base64url chars> — accept anything starting with flv_ for forward
  // compat with longer keys, but require at least the prefix and some body.
  return /^flv_[A-Za-z0-9_-]{8,}$/.test(key);
}

async function fetchVerify(
  key: string,
): Promise<{ valid: boolean; tier: Tier | null; email_redacted: string | null }> {
  const res = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (!res.ok) {
    throw new Error(`verify ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    valid?: boolean;
    tier?: Tier | null;
    email_redacted?: string | null;
  };
  const tier = data.tier === "pro" || data.tier === "free" ? data.tier : null;
  return {
    valid: !!data.valid,
    tier,
    email_redacted: data.email_redacted ?? null,
  };
}

export async function verifyLicense(opts?: {
  key?: string;
}): Promise<LicenseStatus> {
  const argKey = opts?.key?.trim();
  const envKey = readLicenseKeyFromEnv();
  const key = argKey || envKey;
  const source: LicenseStatus["source"] = argKey
    ? "arg"
    : envKey
      ? "env"
      : "none";

  if (!key) {
    return {
      valid: false,
      tier: null,
      source: "none",
      cached: false,
    };
  }

  if (!looksLikeKey(key)) {
    return {
      valid: false,
      tier: null,
      source,
      cached: false,
      error: "malformed_key",
    };
  }

  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.fetched_at < FRESH_TTL_MS) {
    return {
      ...cached.result,
      source,
      cached: true,
    };
  }

  try {
    const result = await fetchVerify(key);
    cache.set(key, {
      result,
      fetched_at: now,
      last_success_at: now,
    });
    return {
      ...result,
      source,
      cached: false,
      checked_at: new Date(now).toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cached && now - cached.last_success_at < STALE_TTL_MS) {
      // Stale-while-error: serve last good result so a transient outage on the
      // verify endpoint does not lock out a paying user mid-session.
      return {
        ...cached.result,
        source,
        cached: true,
        error: `stale_fallback: ${message}`,
      };
    }
    return {
      valid: false,
      tier: null,
      source,
      cached: false,
      error: `verify_failed: ${message}`,
    };
  }
}

export interface TierGateResult {
  ok: boolean;
  status: LicenseStatus;
  message?: string;
}

export async function requireTier(
  required: Tier,
  opts?: { key?: string },
): Promise<TierGateResult> {
  const status = await verifyLicense(opts);
  if (status.valid && status.tier === required) {
    return { ok: true, status };
  }
  if (status.valid && required === "free") {
    // 'free' is a floor — pro qualifies too.
    return { ok: true, status };
  }
  if (status.valid && status.tier === "pro" && required === "free") {
    return { ok: true, status };
  }
  return { ok: false, status, message: tierGateMessage(required, status) };
}

function tierGateMessage(required: Tier, status: LicenseStatus): string {
  if (status.source === "none") {
    return [
      `This tool requires a FlowVault Audit ${required.toUpperCase()} license.`,
      "",
      "Get one at https://flowvault.se/pro and paste the license key into the FlowVault Audit extension settings in Claude Desktop (the `License key` field).",
    ].join("\n");
  }
  if (status.error === "malformed_key") {
    return [
      "The license key in your FlowVault Audit extension settings is malformed.",
      "Expected format: `flv_<token>` (issued at https://flowvault.se/pro).",
    ].join("\n");
  }
  if (!status.valid) {
    return [
      `Your FlowVault Audit license key was not recognized (or has been revoked).`,
      "Verify the key on your profile at https://flowvault.se, or contact gustav@nordsym.com.",
      status.error ? `\nDiagnostic: ${status.error}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  // Valid but wrong tier.
  return [
    `This tool requires the ${required.toUpperCase()} tier. Your license is on ${status.tier?.toUpperCase() ?? "FREE"}.`,
    "",
    "Upgrade at https://flowvault.se/pro to unlock portfolio audits, scheduled re-audits, and the full reliability layer as it ships.",
  ].join("\n");
}
