// Audit report formatter + production-readiness grading.
//
// The report has two surfaces:
//
// - A structured `AuditReport` (returned to MCP clients as `structuredContent`
//   for programmatic access).
// - A markdown render, included as `text` content for human-readable display
//   inside Claude Desktop.
//
// Grade rubric (from FlowVault PRD):
//   🟢 production-ready  - 0 critical, 0 high, ≤2 medium
//   🟡 conditional       - 0 critical, ≤2 high, any medium
//   🔴 not-ready         - 1+ critical, OR 3+ high

import type {
  AuditReport,
  Finding,
  Grade,
  RuleId,
  Severity,
  SeveritySummary,
} from "./types.js";
import type { N8nWorkflow } from "./n8n-types.js";

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "🔴 CRITICAL",
  high: "🟠 HIGH",
  medium: "🟡 MEDIUM",
  low: "🔵 LOW",
  info: "⚪ INFO",
};

function emptySummary(): SeveritySummary {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0 };
}

function summarize(findings: Finding[]): SeveritySummary {
  const s = emptySummary();
  for (const f of findings) {
    s[f.severity] += 1;
    s.total += 1;
  }
  return s;
}

function gradeFromSummary(s: SeveritySummary): {
  grade: Grade;
  emoji: "🟢" | "🟡" | "🔴";
} {
  if (s.critical >= 1 || s.high >= 3) {
    return { grade: "not-ready", emoji: "🔴" };
  }
  if (s.high >= 1 || s.medium >= 1) {
    return { grade: "conditional", emoji: "🟡" };
  }
  return { grade: "production-ready", emoji: "🟢" };
}

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) return sev;
    return a.node_name?.localeCompare(b.node_name ?? "") ?? 0;
  });
}

export function buildReport(
  workflow: N8nWorkflow,
  findings: Finding[],
  rulesRun: RuleId[],
  notes: string[] = [],
): AuditReport {
  const sorted = sortFindings(findings);
  const summary = summarize(sorted);
  const { grade, emoji } = gradeFromSummary(summary);
  return {
    generated_at: new Date().toISOString(),
    workflow_name: workflow.name ?? "(unnamed workflow)",
    workflow_node_count: workflow.nodes.length,
    grade,
    grade_emoji: emoji,
    summary,
    findings: sorted,
    rules_run: rulesRun,
    notes,
  };
}

export function renderMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(
    `# FlowVault Audit Report ${report.grade_emoji} ${report.grade.toUpperCase()}`,
  );
  lines.push("");
  lines.push(`**Workflow:** ${report.workflow_name}`);
  lines.push(`**Nodes:** ${report.workflow_node_count}`);
  lines.push(`**Generated:** ${report.generated_at}`);
  lines.push(`**Rules run:** ${report.rules_run.join(", ")}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Severity | Count |");
  lines.push("|----------|-------|");
  lines.push(`| 🔴 Critical | ${report.summary.critical} |`);
  lines.push(`| 🟠 High     | ${report.summary.high} |`);
  lines.push(`| 🟡 Medium   | ${report.summary.medium} |`);
  lines.push(`| 🔵 Low      | ${report.summary.low} |`);
  lines.push(`| ⚪ Info     | ${report.summary.info} |`);
  lines.push(`| **Total**   | **${report.summary.total}** |`);
  lines.push("");

  if (report.findings.length === 0) {
    lines.push("## Findings");
    lines.push("");
    lines.push(
      "No findings. The three reliability rules pass on this workflow as-is.",
    );
    lines.push("");
  } else {
    lines.push("## Findings");
    lines.push("");
    for (const finding of report.findings) {
      const where = finding.node_name
        ? `\`${finding.node_name}\`${finding.node_id ? ` (id ${finding.node_id})` : ""}`
        : "(workflow-level)";
      lines.push(
        `### ${SEVERITY_LABEL[finding.severity]} · ${finding.rule}`,
      );
      lines.push("");
      lines.push(`**Node:** ${where}`);
      lines.push(`**Issue:** ${finding.message}`);
      lines.push(`**Fix:** ${finding.fix_hint}`);
      lines.push("");
    }
  }

  if (report.notes.length > 0) {
    lines.push("## Notes");
    lines.push("");
    for (const n of report.notes) lines.push(`- ${n}`);
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "FlowVault Audit MCP · deterministic reliability audit · https://flowvault.se",
  );
  return lines.join("\n");
}
