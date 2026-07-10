// Execution-evidence audit: grades what a workflow's recent runs actually did,
// not what the workflow JSON promises.
//
// Pure analysis core (analyzeExecutions) is separated from the fetch wrappers
// so the rule logic is testable with fixtures and never needs a live n8n.
//
// This is the green-but-wrong layer: a run can be status=success while the
// send node it exists for never executed. Static linting cannot see that;
// runData can.

import { z } from "zod";
import type { N8nWorkflow } from "./n8n-types.js";
import { parseWorkflow } from "./n8n-types.js";
import { isSendNode } from "./rules/shared.js";
import type { ExecFinding, Severity } from "./types.js";
import {
  getExecution,
  getWorkflow,
  listExecutions,
  listWorkflows,
  type N8nClientConfig,
  type N8nExecutionSummary,
} from "./n8n-client.js";

// ─── Execution detail (from GET /executions/:id?includeData=true) ────────────

export interface ExecutionDetail {
  id: string;
  status?: string;
  mode?: string;
  startedAt?: string;
  stoppedAt?: string | null;
  executedNodeNames: string[];
  lastNodeExecuted?: string;
  errorMessage?: string;
}

export function parseExecutionDetail(raw: unknown): ExecutionDetail | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const id = (e["id"] as string | number | undefined)?.toString();
  if (!id) return null;

  let executedNodeNames: string[] = [];
  let lastNodeExecuted: string | undefined;
  let errorMessage: string | undefined;
  const data = e["data"];
  if (data && typeof data === "object") {
    const resultData = (data as Record<string, unknown>)["resultData"];
    if (resultData && typeof resultData === "object") {
      const rd = resultData as Record<string, unknown>;
      const runData = rd["runData"];
      if (runData && typeof runData === "object") {
        executedNodeNames = Object.keys(runData as Record<string, unknown>);
      }
      const last = rd["lastNodeExecuted"];
      if (typeof last === "string") lastNodeExecuted = last;
      const err = rd["error"];
      if (err && typeof err === "object") {
        const msg = (err as Record<string, unknown>)["message"];
        if (typeof msg === "string") errorMessage = msg;
      }
    }
  }

  return {
    id,
    status: (e["status"] as string | undefined) ?? undefined,
    mode: (e["mode"] as string | undefined) ?? undefined,
    startedAt: (e["startedAt"] as string | undefined) ?? undefined,
    stoppedAt: (e["stoppedAt"] as string | null | undefined) ?? null,
    executedNodeNames,
    lastNodeExecuted,
    errorMessage,
  };
}

// ─── Receipt: flowvault.receipt/v1 ───────────────────────────────────────────

export const RECEIPT_SCHEMA_ID = "flowvault.receipt/v1" as const;

export const ReceiptSchema = z.object({
  schema: z.literal(RECEIPT_SCHEMA_ID),
  generated_at: z.string(),
  workflow_id: z.string(),
  workflow_name: z.string(),
  execution_id: z.string(),
  status: z.string(),
  mode: z.string().nullable(),
  started_at: z.string().nullable(),
  stopped_at: z.string().nullable(),
  duration_ms: z.number().nullable(),
  verdict: z.enum([
    "delivered",
    "delivered-with-warnings",
    "silent-failure",
    "failed",
    "indeterminate",
  ]),
  nodes_executed: z.array(z.string()).nullable(),
  nodes_expected_but_silent: z.array(z.string()).nullable(),
  last_node_executed: z.string().nullable(),
  error_message: z.string().nullable(),
  finding_rules: z.array(z.string()),
});

export type Receipt = z.infer<typeof ReceiptSchema>;

function durationMs(startedAt?: string, stoppedAt?: string | null): number | null {
  if (!startedAt || !stoppedAt) return null;
  const a = Date.parse(startedAt);
  const b = Date.parse(stoppedAt);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, b - a);
}

// ─── Analysis core (pure) ─────────────────────────────────────────────────────

export interface ExecutionAnalysis {
  workflow_id: string;
  workflow_name: string;
  active: boolean;
  window: number;
  counts: { success: number; error: number; running: number; waiting: number; other: number };
  findings: ExecFinding[];
  receipts: Receipt[];
}

const FAILED_STATUSES = new Set(["error", "crashed", "failed"]);
const IN_FLIGHT_STATUSES = new Set(["running", "new"]);

function statusOf(e: N8nExecutionSummary): string {
  if (e.status) return e.status;
  // Older n8n has no status field: infer from finished + stoppedAt.
  if (e.finished === true) return "success";
  if (e.finished === false && e.stoppedAt) return "error";
  return "unknown";
}

export function analyzeExecutions(
  workflow: N8nWorkflow,
  workflowId: string,
  executions: N8nExecutionSummary[],
  details: Map<string, ExecutionDetail>,
  now: Date = new Date(),
): ExecutionAnalysis {
  const findings: ExecFinding[] = [];
  const receipts: Receipt[] = [];
  const active = workflow.active === true;
  const workflowName = workflow.name ?? "(unnamed)";

  const counts = { success: 0, error: 0, running: 0, waiting: 0, other: 0 };
  for (const e of executions) {
    const s = statusOf(e);
    if (s === "success") counts.success += 1;
    else if (FAILED_STATUSES.has(s)) counts.error += 1;
    else if (IN_FLIGHT_STATUSES.has(s)) counts.running += 1;
    else if (s === "waiting") counts.waiting += 1;
    else counts.other += 1;
  }
  const finishedTotal = counts.success + counts.error;

  // Expected side-effect surface: enabled send nodes in the workflow.
  const sendNodeNames = workflow.nodes
    .filter((n) => !n.disabled && isSendNode(n))
    .map((n) => n.name);

  // E1 - error rate over the window.
  if (finishedTotal > 0 && counts.error > 0) {
    const ratio = counts.error / finishedTotal;
    let severity: Severity = "low";
    if (ratio >= 0.5) severity = active ? "critical" : "high";
    else if (ratio >= 0.2) severity = "medium";
    findings.push({
      rule: "E1.error-rate",
      severity,
      execution_id: null,
      node_name: null,
      message: `${counts.error} of the last ${finishedTotal} finished executions failed (${Math.round(ratio * 100)}%).${active ? " Workflow is ACTIVE, so this is live breakage." : ""}`,
      fix_hint:
        "Open the failed executions and check the first failing node. If failures cluster on one integration, add error handling + retry there; if they are spread out, suspect credentials or upstream schema drift.",
    });
  }

  // E2 - silent active: an active workflow with no executions at all, or runs
  // stuck in flight.
  if (active && executions.length === 0) {
    findings.push({
      rule: "E2.silent-active",
      severity: "high",
      execution_id: null,
      node_name: null,
      message:
        "Workflow is ACTIVE but has zero executions in the inspection window. The trigger may be dead (webhook deregistered, poll auth expired) and nobody would know.",
      fix_hint:
        "Fire the trigger manually and confirm an execution appears. For webhooks, re-save/reactivate the workflow to re-register the webhook. Add a heartbeat check if this workflow matters.",
    });
  }
  const RUNNING_STUCK_MS = 6 * 60 * 60 * 1000;
  const WAITING_STUCK_MS = 7 * 24 * 60 * 60 * 1000;
  for (const e of executions) {
    const s = statusOf(e);
    const started = e.startedAt ? Date.parse(e.startedAt) : NaN;
    if (Number.isNaN(started)) continue;
    const age = now.getTime() - started;
    if (IN_FLIGHT_STATUSES.has(s) && age > RUNNING_STUCK_MS) {
      findings.push({
        rule: "E2.silent-active",
        severity: "medium",
        execution_id: e.id,
        node_name: null,
        message: `Execution ${e.id} has been in status "${s}" for over ${Math.round(age / 3600000)}h. Likely hung on a node with no timeout.`,
        fix_hint: "Cancel the stuck execution, then set explicit timeouts on HTTP/LLM/DB nodes (see rule R5 in the static audit).",
      });
    } else if (s === "waiting" && age > WAITING_STUCK_MS) {
      findings.push({
        rule: "E2.silent-active",
        severity: "low",
        execution_id: e.id,
        node_name: null,
        message: `Execution ${e.id} has been waiting for over ${Math.round(age / 86400000)} days. If this is not an intentional long Wait, it is orphaned.`,
        fix_hint: "Inspect the Wait node conditions; cancel orphaned executions so they stop holding state.",
      });
    }
  }

  // E3 - green-but-empty + receipts, for every execution we have detail on.
  for (const e of executions) {
    const detail = details.get(e.id);
    const s = statusOf(e);
    if (!detail) {
      receipts.push({
        schema: RECEIPT_SCHEMA_ID,
        generated_at: now.toISOString(),
        workflow_id: workflowId,
        workflow_name: workflowName,
        execution_id: e.id,
        status: s,
        mode: e.mode ?? null,
        started_at: e.startedAt ?? null,
        stopped_at: e.stoppedAt ?? null,
        duration_ms: durationMs(e.startedAt, e.stoppedAt),
        verdict: FAILED_STATUSES.has(s) ? "failed" : s === "success" ? "delivered" : "indeterminate",
        nodes_executed: null,
        nodes_expected_but_silent: null,
        last_node_executed: null,
        error_message: null,
        finding_rules: [],
      });
      continue;
    }

    const silentSends =
      s === "success" && sendNodeNames.length > 0
        ? sendNodeNames.filter((n) => !detail.executedNodeNames.includes(n))
        : [];
    const ranAnySend = sendNodeNames.some((n) => detail.executedNodeNames.includes(n));
    const findingRules: string[] = [];

    if (s === "success" && sendNodeNames.length > 0 && silentSends.length > 0) {
      const allSilent = !ranAnySend;
      findings.push({
        rule: "E3.green-but-empty",
        severity: allSilent ? "high" : "medium",
        execution_id: e.id,
        node_name: silentSends[0],
        message: `Execution ${e.id} finished with status success but ${allSilent ? "NONE of the" : `${silentSends.length} of ${sendNodeNames.length}`} send node(s) ran (silent: ${silentSends.join(", ")}). The run is green; the delivery may not have happened.`,
        fix_hint:
          "If an upstream gate legitimately skipped the send, route the skip branch through a logging node so skips are visible evidence, not silence. If the skip is not intentional, check IF/Switch wiring upstream of the send (see rule R2 inversion pattern).",
      });
      findingRules.push("E3.green-but-empty");
    }

    let verdict: Receipt["verdict"];
    if (FAILED_STATUSES.has(s)) verdict = "failed";
    else if (s !== "success") verdict = "indeterminate";
    else if (sendNodeNames.length === 0) verdict = "delivered";
    else if (!ranAnySend) verdict = "silent-failure";
    else if (silentSends.length > 0) verdict = "delivered-with-warnings";
    else verdict = "delivered";

    receipts.push({
      schema: RECEIPT_SCHEMA_ID,
      generated_at: now.toISOString(),
      workflow_id: workflowId,
      workflow_name: workflowName,
      execution_id: e.id,
      status: s,
      mode: detail.mode ?? e.mode ?? null,
      started_at: detail.startedAt ?? e.startedAt ?? null,
      stopped_at: detail.stoppedAt ?? e.stoppedAt ?? null,
      duration_ms: durationMs(detail.startedAt ?? e.startedAt, detail.stoppedAt ?? e.stoppedAt),
      verdict,
      nodes_executed: detail.executedNodeNames,
      nodes_expected_but_silent: sendNodeNames.length > 0 ? silentSends : [],
      last_node_executed: detail.lastNodeExecuted ?? null,
      error_message: detail.errorMessage ?? null,
      finding_rules: findingRules,
    });
  }

  // E4 - errors happened, but no error path exists to catch them.
  if (counts.error > 0) {
    const settings = (workflow.settings ?? {}) as Record<string, unknown>;
    const hasErrorWorkflow =
      typeof settings["errorWorkflow"] === "string" && settings["errorWorkflow"] !== "";
    const hasNodeErrorHandling = workflow.nodes.some(
      (n) =>
        !n.disabled &&
        (n.onError === "continueErrorOutput" ||
          n.continueOnFail === true ||
          Object.keys(workflow.connections?.[n.name] ?? {}).includes("error")),
    );
    if (!hasErrorWorkflow && !hasNodeErrorHandling) {
      findings.push({
        rule: "E4.unhandled-error-path",
        severity: active ? "high" : "medium",
        execution_id: null,
        node_name: null,
        message: `${counts.error} execution(s) failed in the window and this workflow has no error workflow configured and no error branch on any node. Failures die silently.`,
        fix_hint:
          "Set an Error Workflow in workflow settings (Telegram/Slack alert at minimum), or add error outputs on failable nodes routed to a notification.",
      });
    }
  }

  return {
    workflow_id: workflowId,
    workflow_name: workflowName,
    active,
    window: executions.length,
    counts,
    findings,
    receipts,
  };
}

// ─── Fetch wrappers ───────────────────────────────────────────────────────────

const DETAIL_FETCH_CAP = 5;

export async function auditExecutionsForWorkflow(
  cfg: N8nClientConfig,
  workflowId: string,
  opts: { lookback?: number } = {},
): Promise<{ ok: true; analysis: ExecutionAnalysis } | { ok: false; error: string }> {
  const lookback = opts.lookback && opts.lookback > 0 ? Math.min(opts.lookback, 200) : 20;

  const fetched = await getWorkflow(cfg, workflowId);
  if (!fetched.ok) return { ok: false, error: fetched.error.message };
  let workflow: N8nWorkflow;
  try {
    workflow = parseWorkflow(fetched.value);
  } catch (err) {
    return { ok: false, error: `Workflow ${workflowId} did not parse: ${err instanceof Error ? err.message : String(err)}` };
  }

  const list = await listExecutions(cfg, { workflowId, limit: lookback });
  if (!list.ok) return { ok: false, error: list.error.message };
  const executions = list.value;

  // Fetch run data for the most recent successes (green-but-empty target) and
  // the most recent failure (error message for the receipt), capped to keep
  // API load sane.
  const details = new Map<string, ExecutionDetail>();
  const successIds = executions.filter((e) => statusOf(e) === "success").slice(0, DETAIL_FETCH_CAP).map((e) => e.id);
  const firstFailure = executions.find((e) => FAILED_STATUSES.has(statusOf(e)));
  const wanted = firstFailure ? [...successIds, firstFailure.id] : successIds;
  for (const id of wanted) {
    const res = await getExecution(cfg, id);
    if (!res.ok) continue; // Detail fetch is best-effort; list-level rules still apply.
    const detail = parseExecutionDetail(res.value);
    if (detail) details.set(id, detail);
  }

  return { ok: true, analysis: analyzeExecutions(workflow, workflowId, executions, details) };
}

export interface ExecutionHealthEntry {
  workflow_id: string;
  workflow_name: string;
  active: boolean;
  window: number;
  error_count: number;
  success_count: number;
  worst_severity: Severity | null;
  findings: ExecFinding[];
  error_message?: string;
}

export interface ExecutionHealthReport {
  generated_at: string;
  base_url: string;
  lookback_per_workflow: number;
  workflows_scanned: number;
  entries: ExecutionHealthEntry[];
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

function worstSeverity(findings: ExecFinding[]): Severity | null {
  for (const s of SEVERITY_ORDER) if (findings.some((f) => f.severity === s)) return s;
  return null;
}

// Portfolio sweep. List-level rules only (E1/E2/E4 need no run data); the
// per-execution green-but-empty pass stays in the single-workflow tool to keep
// the sweep at one API call per workflow.
export async function executionHealth(
  cfg: N8nClientConfig,
  opts: { activeOnly?: boolean; lookback?: number; limit?: number } = {},
): Promise<{ ok: true; report: ExecutionHealthReport } | { ok: false; error: string }> {
  const lookback = opts.lookback && opts.lookback > 0 ? Math.min(opts.lookback, 100) : 20;
  const list = await listWorkflows(cfg, { activeOnly: opts.activeOnly, limit: opts.limit });
  if (!list.ok) return { ok: false, error: list.error.message };

  const entries: ExecutionHealthEntry[] = [];
  for (const w of list.value) {
    const fetched = await getWorkflow(cfg, w.id);
    if (!fetched.ok) {
      entries.push({
        workflow_id: w.id, workflow_name: w.name, active: w.active,
        window: 0, error_count: 0, success_count: 0, worst_severity: null,
        findings: [], error_message: fetched.error.message,
      });
      continue;
    }
    let workflow: N8nWorkflow;
    try {
      workflow = parseWorkflow(fetched.value);
    } catch (err) {
      entries.push({
        workflow_id: w.id, workflow_name: w.name, active: w.active,
        window: 0, error_count: 0, success_count: 0, worst_severity: null,
        findings: [], error_message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const execs = await listExecutions(cfg, { workflowId: w.id, limit: lookback });
    if (!execs.ok) {
      entries.push({
        workflow_id: w.id, workflow_name: w.name, active: w.active,
        window: 0, error_count: 0, success_count: 0, worst_severity: null,
        findings: [], error_message: execs.error.message,
      });
      continue;
    }
    const analysis = analyzeExecutions(workflow, w.id, execs.value, new Map());
    entries.push({
      workflow_id: w.id,
      workflow_name: w.name,
      active: w.active,
      window: analysis.window,
      error_count: analysis.counts.error,
      success_count: analysis.counts.success,
      worst_severity: worstSeverity(analysis.findings),
      findings: analysis.findings,
    });
  }

  entries.sort((a, b) => {
    const rank = (x: ExecutionHealthEntry) =>
      x.worst_severity ? SEVERITY_ORDER.indexOf(x.worst_severity) : SEVERITY_ORDER.length;
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return b.error_count - a.error_count;
  });

  return {
    ok: true,
    report: {
      generated_at: new Date().toISOString(),
      base_url: cfg.baseUrl,
      lookback_per_workflow: lookback,
      workflows_scanned: list.value.length,
      entries,
    },
  };
}

// ─── Markdown renders ─────────────────────────────────────────────────────────

const SEV_EMOJI: Record<Severity, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
  info: "⚪",
};

export function renderExecutionMarkdown(a: ExecutionAnalysis): string {
  const lines: string[] = [];
  lines.push(`# FlowVault Execution Audit - ${a.workflow_name}`);
  lines.push("");
  lines.push(`**Workflow:** \`${a.workflow_id}\` (${a.active ? "ACTIVE" : "inactive"})`);
  lines.push(`**Window:** last ${a.window} executions`);
  lines.push(`**Outcomes:** ${a.counts.success} success · ${a.counts.error} failed · ${a.counts.running} running · ${a.counts.waiting} waiting`);
  lines.push("");
  if (a.findings.length === 0) {
    lines.push("No execution-evidence findings. Recent runs both finished and exercised their send nodes.");
  } else {
    lines.push("## Findings");
    lines.push("");
    for (const f of a.findings) {
      lines.push(`### ${SEV_EMOJI[f.severity]} ${f.severity.toUpperCase()} · ${f.rule}${f.execution_id ? ` · execution ${f.execution_id}` : ""}`);
      lines.push("");
      lines.push(f.message);
      lines.push("");
      lines.push(`**Fix:** ${f.fix_hint}`);
      lines.push("");
    }
  }
  if (a.receipts.length > 0) {
    lines.push("## Run receipts");
    lines.push("");
    lines.push("| Execution | Status | Verdict | Duration | Silent send nodes |");
    lines.push("|-----------|--------|---------|---------:|-------------------|");
    for (const r of a.receipts) {
      const dur = r.duration_ms === null ? "-" : `${(r.duration_ms / 1000).toFixed(1)}s`;
      const silent = r.nodes_expected_but_silent === null ? "n/a" : r.nodes_expected_but_silent.join(", ") || "-";
      lines.push(`| \`${r.execution_id}\` | ${r.status} | **${r.verdict}** | ${dur} | ${silent} |`);
    }
    lines.push("");
    lines.push(`Structured receipts (\`${RECEIPT_SCHEMA_ID}\`) are in structuredContent.receipts, ready to store.`);
  }
  lines.push("");
  lines.push("---");
  lines.push("FlowVault Audit MCP · execution evidence, not just structure · https://flowvault.se");
  return lines.join("\n");
}

export function renderExecutionHealthMarkdown(r: ExecutionHealthReport): string {
  const lines: string[] = [];
  lines.push(`# FlowVault Execution Health - portfolio`);
  lines.push("");
  lines.push(`**n8n instance:** ${r.base_url}`);
  lines.push(`**Workflows scanned:** ${r.workflows_scanned} · lookback ${r.lookback_per_workflow} executions each`);
  lines.push("");
  lines.push("| Sev | Workflow | Active | Window | Failed | Success | Top finding |");
  lines.push("|-----|----------|--------|-------:|-------:|--------:|-------------|");
  for (const e of r.entries) {
    const sev = e.worst_severity ? `${SEV_EMOJI[e.worst_severity]} ${e.worst_severity}` : "✅";
    const top = e.error_message
      ? `error: ${e.error_message.slice(0, 60)}`
      : e.findings[0]?.message.slice(0, 80) ?? "-";
    const name = e.workflow_name.replace(/\|/g, "\\|");
    lines.push(`| ${sev} | \`${e.workflow_id}\` ${name} | ${e.active ? "yes" : "no"} | ${e.window} | ${e.error_count} | ${e.success_count} | ${top} |`);
  }
  lines.push("");
  lines.push("Run `audit_n8n_executions` on any workflow above for per-run receipts and the green-but-empty check.");
  lines.push("");
  lines.push("---");
  lines.push("FlowVault Audit MCP · execution evidence, not just structure · https://flowvault.se");
  return lines.join("\n");
}
