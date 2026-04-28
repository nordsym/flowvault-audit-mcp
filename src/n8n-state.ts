// In-process connection state for the n8n REST API tools.
//
// Lifecycle:
//   - On server start, env vars N8N_BASE_URL and N8N_API_KEY (if both set)
//     seed the connection so the user can call list/audit immediately.
//   - connect_n8n explicitly overrides whatever was seeded from env.
//   - Per-call base_url / api_key always override the stored connection for
//     that one call (without mutating the stored state).
//
// The state lives in this module. The MCP server is a single Node process
// per user, so module-scope is fine - no multi-tenancy concerns.

import { normalizeBaseUrl, type N8nClientConfig } from "./n8n-client.js";

let connection: N8nClientConfig | null = null;
let connectionSource: "env" | "connect_n8n" | "none" = "none";

export function seedFromEnv(): void {
  const base = process.env.N8N_BASE_URL?.trim();
  const key = process.env.N8N_API_KEY?.trim();
  if (base && key) {
    connection = { baseUrl: normalizeBaseUrl(base), apiKey: key };
    connectionSource = "env";
  }
}

export function getConnectionSource(): "env" | "connect_n8n" | "none" {
  return connectionSource;
}

export function envSnapshot(): {
  N8N_BASE_URL_set: boolean;
  N8N_API_KEY_set: boolean;
  N8N_BASE_URL_value: string | null;
} {
  const base = process.env.N8N_BASE_URL?.trim();
  const key = process.env.N8N_API_KEY?.trim();
  return {
    N8N_BASE_URL_set: !!base,
    N8N_API_KEY_set: !!key,
    N8N_BASE_URL_value: base ?? null,
  };
}

export function setConnection(baseUrl: string, apiKey: string): N8nClientConfig {
  connection = { baseUrl: normalizeBaseUrl(baseUrl), apiKey };
  connectionSource = "connect_n8n";
  return connection;
}

export function getConnection(): N8nClientConfig | null {
  return connection;
}

export function clearConnection(): void {
  connection = null;
  connectionSource = "none";
}

// Build a per-call config: explicit args override stored state. Both must be
// present for a usable config; missing fields preserve the stored ones.
export function resolveConfig(
  override?: { base_url?: string; api_key?: string },
): N8nClientConfig | null {
  const stored = connection;
  const base = override?.base_url ?? stored?.baseUrl;
  const key = override?.api_key ?? stored?.apiKey;
  if (!base || !key) return null;
  return { baseUrl: normalizeBaseUrl(base), apiKey: key };
}

// Redact the api key for logs / responses. Show only first 4 + last 4.
export function redactApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 10) return "***";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}
