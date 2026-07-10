// n8n REST API client.
//
// Talks to the user's own n8n instance via the X-N8N-API-KEY header. All
// requests originate from the user's machine; FlowVault Audit MCP never
// proxies through a NordSym endpoint.
//
// Endpoints used:
//   GET /api/v1/workflows               -> list workflows (paginated via cursor)
//   GET /api/v1/workflows/:id           -> single workflow with nodes + connections
//
// Error model: every method returns a discriminated union {ok:true,...} or
// {ok:false, error}. Callers decide whether to surface as MCP isError or as
// a finding inside the report.

export interface N8nClientConfig {
  baseUrl: string;
  apiKey: string;
}

export interface N8nWorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  tags?: Array<{ id?: string; name?: string }>;
  updatedAt?: string;
}

export type N8nResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        kind: "config" | "auth" | "not_found" | "rate_limited" | "network" | "remote" | "parse";
        message: string;
        status?: number;
      };
    };

function trimSlashes(u: string): string {
  return u.replace(/\/+$/, "");
}

export function normalizeBaseUrl(rawBaseUrl: string): string {
  let u = rawBaseUrl.trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  // Some users paste `.../api/v1` - tolerate that.
  u = u.replace(/\/api\/v1\/?$/i, "");
  return trimSlashes(u);
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "X-N8N-API-KEY": apiKey,
    Accept: "application/json",
    "User-Agent": "flowvault-audit-mcp/0.2.0",
  };
}

async function request<T>(
  cfg: N8nClientConfig,
  path: string,
  init?: RequestInit,
): Promise<N8nResult<T>> {
  if (!cfg.baseUrl) {
    return { ok: false, error: { kind: "config", message: "Missing n8n base_url. Call connect_n8n first or set N8N_BASE_URL." } };
  }
  if (!cfg.apiKey) {
    return { ok: false, error: { kind: "config", message: "Missing n8n api_key. Call connect_n8n first or set N8N_API_KEY." } };
  }
  const url = `${cfg.baseUrl}${path}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      ...init,
      headers: { ...buildHeaders(cfg.apiKey), ...(init?.headers ?? {}) },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: "network", message: `Network error talking to ${url}: ${msg}` } };
  }
  if (resp.status === 401 || resp.status === 403) {
    return {
      ok: false,
      error: {
        kind: "auth",
        status: resp.status,
        message: `n8n rejected the API key (${resp.status}). Verify the key is correct and has read access to workflows.`,
      },
    };
  }
  if (resp.status === 404) {
    return {
      ok: false,
      error: {
        kind: "not_found",
        status: 404,
        message: `n8n returned 404 for ${path}. The workflow id may not exist or the base URL is missing the API path.`,
      },
    };
  }
  if (resp.status === 429) {
    return {
      ok: false,
      error: { kind: "rate_limited", status: 429, message: "n8n rate-limited the request (429). Slow down and retry." },
    };
  }
  if (!resp.ok) {
    let detail = "";
    try {
      detail = (await resp.text()).slice(0, 500);
    } catch {
      detail = "";
    }
    return {
      ok: false,
      error: { kind: "remote", status: resp.status, message: `n8n returned ${resp.status} for ${path}. ${detail}` },
    };
  }
  let data: unknown;
  try {
    data = await resp.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: "parse", message: `n8n response was not JSON: ${msg}` } };
  }
  return { ok: true, value: data as T };
}

// Quick auth ping: HEAD /workflows is not supported on all n8n versions, so we
// list with limit=1 and treat the response shape as confirmation.
export async function ping(cfg: N8nClientConfig): Promise<N8nResult<{ count: number }>> {
  const res = await request<{ data: unknown[] }>(cfg, "/api/v1/workflows?limit=1");
  if (!res.ok) return res;
  if (!res.value || !Array.isArray(res.value.data)) {
    return { ok: false, error: { kind: "parse", message: "n8n returned an unexpected workflow list shape on auth ping." } };
  }
  return { ok: true, value: { count: res.value.data.length } };
}

interface WorkflowsListResponse {
  data: Array<Record<string, unknown>>;
  nextCursor?: string | null;
}

export async function listWorkflows(
  cfg: N8nClientConfig,
  opts: { activeOnly?: boolean; limit?: number } = {},
): Promise<N8nResult<N8nWorkflowSummary[]>> {
  const params = new URLSearchParams();
  // n8n caps a single page; we paginate to honor `limit` if larger.
  const pageSize = 100;
  const targetLimit = opts.limit && opts.limit > 0 ? opts.limit : 1000;
  if (opts.activeOnly === true) params.set("active", "true");
  params.set("limit", String(Math.min(pageSize, targetLimit)));

  const out: N8nWorkflowSummary[] = [];
  let cursor: string | undefined = undefined;
  while (out.length < targetLimit) {
    if (cursor) params.set("cursor", cursor);
    const res = await request<WorkflowsListResponse>(cfg, `/api/v1/workflows?${params.toString()}`);
    if (!res.ok) return res;
    const page = res.value.data ?? [];
    for (const w of page) {
      const id = (w["id"] as string | number | undefined)?.toString();
      const name = (w["name"] as string | undefined) ?? "(unnamed)";
      const active = (w["active"] as boolean | undefined) ?? false;
      const updatedAt = (w["updatedAt"] as string | undefined) ?? undefined;
      const tags = (w["tags"] as Array<{ id?: string; name?: string }> | undefined) ?? undefined;
      if (!id) continue;
      out.push({ id, name, active, updatedAt, tags });
      if (out.length >= targetLimit) break;
    }
    cursor = res.value.nextCursor ?? undefined;
    if (!cursor || page.length === 0) break;
  }
  return { ok: true, value: out };
}

export interface N8nExecutionSummary {
  id: string;
  workflowId: string;
  status?: string;
  finished?: boolean;
  mode?: string;
  startedAt?: string;
  stoppedAt?: string | null;
  waitTill?: string | null;
}

interface ExecutionsListResponse {
  data: Array<Record<string, unknown>>;
  nextCursor?: string | null;
}

function toExecutionSummary(e: Record<string, unknown>): N8nExecutionSummary | null {
  const id = (e["id"] as string | number | undefined)?.toString();
  const workflowId = (e["workflowId"] as string | number | undefined)?.toString();
  if (!id || !workflowId) return null;
  return {
    id,
    workflowId,
    status: (e["status"] as string | undefined) ?? undefined,
    finished: (e["finished"] as boolean | undefined) ?? undefined,
    mode: (e["mode"] as string | undefined) ?? undefined,
    startedAt: (e["startedAt"] as string | undefined) ?? undefined,
    stoppedAt: (e["stoppedAt"] as string | null | undefined) ?? null,
    waitTill: (e["waitTill"] as string | null | undefined) ?? null,
  };
}

// Lists executions newest-first, paginating up to `limit`.
export async function listExecutions(
  cfg: N8nClientConfig,
  opts: { workflowId?: string; status?: "error" | "success" | "waiting"; limit?: number } = {},
): Promise<N8nResult<N8nExecutionSummary[]>> {
  const pageSize = 100;
  const targetLimit = opts.limit && opts.limit > 0 ? opts.limit : 100;

  const out: N8nExecutionSummary[] = [];
  let cursor: string | undefined = undefined;
  while (out.length < targetLimit) {
    const params = new URLSearchParams();
    if (opts.workflowId) params.set("workflowId", opts.workflowId);
    if (opts.status) params.set("status", opts.status);
    params.set("limit", String(Math.min(pageSize, targetLimit - out.length)));
    if (cursor) params.set("cursor", cursor);
    const res = await request<ExecutionsListResponse>(cfg, `/api/v1/executions?${params.toString()}`);
    if (!res.ok) return res;
    const page = res.value.data ?? [];
    for (const e of page) {
      const summary = toExecutionSummary(e);
      if (summary) out.push(summary);
      if (out.length >= targetLimit) break;
    }
    cursor = res.value.nextCursor ?? undefined;
    if (!cursor || page.length === 0) break;
  }
  return { ok: true, value: out };
}

// Fetches one execution WITH run data (which nodes actually executed).
export async function getExecution(
  cfg: N8nClientConfig,
  executionId: string,
): Promise<N8nResult<unknown>> {
  if (!executionId) {
    return { ok: false, error: { kind: "config", message: "execution_id is required." } };
  }
  return request<unknown>(
    cfg,
    `/api/v1/executions/${encodeURIComponent(executionId)}?includeData=true`,
  );
}

// Returns the raw workflow JSON shape (nodes + connections + settings).
export async function getWorkflow(
  cfg: N8nClientConfig,
  workflowId: string,
): Promise<N8nResult<unknown>> {
  if (!workflowId) {
    return { ok: false, error: { kind: "config", message: "workflow_id is required." } };
  }
  return request<unknown>(cfg, `/api/v1/workflows/${encodeURIComponent(workflowId)}`);
}
