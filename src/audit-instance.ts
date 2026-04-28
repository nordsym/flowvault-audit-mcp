// Orchestrator for "audit my whole n8n" portfolio runs.
//
// Pulls workflows via the n8n API client, runs the same deterministic rule
// set on each, and rolls up to a portfolio summary. Same audit core, no LLM.

import { getWorkflow, listWorkflows, type N8nClientConfig, type N8nWorkflowSummary } from "./n8n-client.js";
import { audit } from "./audit.js";
import type { AuditReport, Grade } from "./types.js";

export interface PortfolioEntry {
  workflow_id: string;
  workflow_name: string;
  active: boolean;
  grade: Grade | "error";
  grade_emoji: "🟢" | "🟡" | "🔴" | "⚠️";
  total_findings: number;
  critical: number;
  high: number;
  medium: number;
  error_message?: string;
  report?: AuditReport;
}

export interface PortfolioReport {
  generated_at: string;
  base_url: string;
  total_workflows: number;
  audited: number;
  errored: number;
  grade_distribution: Record<Grade | "error", number>;
  worst_first: PortfolioEntry[];
}

const ORDER: Record<PortfolioEntry["grade"], number> = {
  "error": 0,
  "not-ready": 1,
  "conditional": 2,
  "production-ready": 3,
};

function gradeEmoji(grade: PortfolioEntry["grade"]): PortfolioEntry["grade_emoji"] {
  switch (grade) {
    case "production-ready": return "🟢";
    case "conditional": return "🟡";
    case "not-ready": return "🔴";
    case "error": return "⚠️";
  }
}

export async function auditWorkflowById(
  cfg: N8nClientConfig,
  workflowId: string,
): Promise<{ ok: true; report: AuditReport; raw: unknown } | { ok: false; error: string }> {
  const fetched = await getWorkflow(cfg, workflowId);
  if (!fetched.ok) return { ok: false, error: fetched.error.message };
  const json = JSON.stringify(fetched.value);
  const result = audit(json);
  if (!result.ok) return { ok: false, error: result.error.detail ?? result.error.error };
  return { ok: true, report: result.report, raw: fetched.value };
}

export async function auditAll(
  cfg: N8nClientConfig,
  opts: { activeOnly?: boolean; limit?: number; includeReports?: boolean } = {},
): Promise<{ ok: true; portfolio: PortfolioReport } | { ok: false; error: string }> {
  const list = await listWorkflows(cfg, { activeOnly: opts.activeOnly, limit: opts.limit });
  if (!list.ok) return { ok: false, error: list.error.message };
  const summaries: N8nWorkflowSummary[] = list.value;

  const entries: PortfolioEntry[] = [];
  let errored = 0;
  for (const s of summaries) {
    const result = await auditWorkflowById(cfg, s.id);
    if (!result.ok) {
      errored += 1;
      entries.push({
        workflow_id: s.id,
        workflow_name: s.name,
        active: s.active,
        grade: "error",
        grade_emoji: "⚠️",
        total_findings: 0,
        critical: 0,
        high: 0,
        medium: 0,
        error_message: result.error,
      });
      continue;
    }
    const r = result.report;
    entries.push({
      workflow_id: s.id,
      workflow_name: s.name,
      active: s.active,
      grade: r.grade,
      grade_emoji: r.grade_emoji,
      total_findings: r.summary.total,
      critical: r.summary.critical,
      high: r.summary.high,
      medium: r.summary.medium,
      report: opts.includeReports ? r : undefined,
    });
  }

  // Sort: worst first, then by critical+high, then by name.
  entries.sort((a, b) => {
    const og = ORDER[a.grade] - ORDER[b.grade];
    if (og !== 0) return og;
    const sev = (b.critical * 10 + b.high) - (a.critical * 10 + a.high);
    if (sev !== 0) return sev;
    return a.workflow_name.localeCompare(b.workflow_name);
  });

  const dist: Record<Grade | "error", number> = {
    "production-ready": 0,
    "conditional": 0,
    "not-ready": 0,
    "error": 0,
  };
  for (const e of entries) dist[e.grade] = (dist[e.grade] ?? 0) + 1;

  return {
    ok: true,
    portfolio: {
      generated_at: new Date().toISOString(),
      base_url: cfg.baseUrl,
      total_workflows: summaries.length,
      audited: summaries.length - errored,
      errored,
      grade_distribution: dist,
      worst_first: entries,
    },
  };
}

export function renderPortfolioMarkdown(p: PortfolioReport): string {
  const lines: string[] = [];
  lines.push(`# FlowVault Portfolio Audit`);
  lines.push("");
  lines.push(`**n8n instance:** ${p.base_url}`);
  lines.push(`**Generated:** ${p.generated_at}`);
  lines.push(`**Workflows scanned:** ${p.total_workflows} (audited ${p.audited}, errored ${p.errored})`);
  lines.push("");
  lines.push("## Grade distribution");
  lines.push("");
  lines.push("| Grade | Count |");
  lines.push("|-------|-------|");
  lines.push(`| 🟢 Production-Ready | ${p.grade_distribution["production-ready"] ?? 0} |`);
  lines.push(`| 🟡 Conditional      | ${p.grade_distribution["conditional"] ?? 0} |`);
  lines.push(`| 🔴 Not Ready        | ${p.grade_distribution["not-ready"] ?? 0} |`);
  lines.push(`| ⚠️ Errored          | ${p.grade_distribution["error"] ?? 0} |`);
  lines.push("");
  lines.push("## Worst first");
  lines.push("");
  lines.push("| Grade | Workflow | Active | Findings | Crit | High | Med |");
  lines.push("|-------|----------|--------|---------:|-----:|-----:|----:|");
  for (const e of p.worst_first) {
    const name = e.workflow_name.replace(/\|/g, "\\|");
    const active = e.active ? "yes" : "no";
    const findings = e.error_message ? `error: ${e.error_message.slice(0, 80)}` : String(e.total_findings);
    lines.push(
      `| ${e.grade_emoji} ${e.grade} | \`${e.workflow_id}\` ${name} | ${active} | ${findings} | ${e.critical} | ${e.high} | ${e.medium} |`,
    );
  }
  lines.push("");
  lines.push("Run `audit_n8n_workflow` with a workflow_id to see the full per-node report and fix hints.");
  lines.push("");
  lines.push("---");
  lines.push("FlowVault Audit MCP · deterministic reliability audit · https://flowvault.se");
  return lines.join("\n");
}
