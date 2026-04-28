// Orchestrator: parse workflow JSON, run all rules, build the structured report.

import { parseWorkflowJSON } from "./n8n-types.js";
import { runErrorCoverage } from "./rules/error-coverage.js";
import { runSuppressionCheck } from "./rules/suppression-check.js";
import { runAuthDrift } from "./rules/auth-drift.js";
import { buildReport, renderMarkdown } from "./report.js";
import type { AuditReport, AuditResult, RuleId } from "./types.js";

export const RULES_RUN: RuleId[] = [
  "R1.error-coverage",
  "R2.suppression-check",
  "R3.auth-drift",
];

export function audit(workflowJson: string): AuditResult {
  let workflow;
  try {
    workflow = parseWorkflowJSON(workflowJson);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        error: "invalid_workflow",
        detail: `Could not parse n8n workflow JSON. ${detail}`,
      },
    };
  }

  const errorFindings = runErrorCoverage(workflow);
  const suppressionFindings = runSuppressionCheck(workflow);
  const authFindings = runAuthDrift(workflow);

  const all = [...errorFindings, ...suppressionFindings, ...authFindings];
  const notes: string[] = [];

  if (workflow.nodes.length === 0) {
    notes.push("Workflow has no nodes. Audit returned trivially.");
  }
  if (workflow.active === false) {
    notes.push(
      "Workflow is marked inactive in n8n. Findings still apply once it is reactivated.",
    );
  }

  const report = buildReport(workflow, all, RULES_RUN, notes);
  return { ok: true, report };
}

export function auditWithMarkdown(workflowJson: string): {
  result: AuditResult;
  markdown: string | null;
} {
  const result = audit(workflowJson);
  if (!result.ok) {
    return {
      result,
      markdown: `# FlowVault Audit Report\n\n**Error:** ${result.error.error}\n\n${result.error.detail ?? ""}\n`,
    };
  }
  return { result, markdown: renderMarkdown(result.report) };
}

export type { AuditReport };
