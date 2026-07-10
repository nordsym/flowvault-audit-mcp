// Orchestrator: parse workflow JSON, run all rules, build the structured report.

import { parseWorkflowJSON } from "./n8n-types.js";
import { runErrorCoverage } from "./rules/error-coverage.js";
import { runSuppressionCheck } from "./rules/suppression-check.js";
import { runAuthDrift } from "./rules/auth-drift.js";
import { runWebhookRespondShape } from "./rules/webhook-respond-shape.js";
import { runHardcodedRecipients } from "./rules/hardcoded-recipients.js";
import { runDeadEndBranches } from "./rules/dead-end-branches.js";
import { runPostSendObservability } from "./rules/post-send-observability.js";
import { runIdempotency } from "./rules/idempotency.js";
import { runTimeouts } from "./rules/timeouts.js";
import { runSubworkflowLoop } from "./rules/subworkflow-loop.js";
import { buildReport, renderMarkdown } from "./report.js";
import type { AuditReport, AuditResult, RuleId } from "./types.js";

export const RULES_RUN: RuleId[] = [
  "R1.error-coverage",
  "R2.suppression-check",
  "R3.auth-drift",
  "R4.idempotency",
  "R5.timeouts",
  "R7.subworkflow-loop",
  "R8.webhook-respond-shape",
  "R9.hardcoded-recipients",
  "R10.dead-end-branches",
  "R11.post-send-observability",
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
  const webhookFindings = runWebhookRespondShape(workflow);
  const hardcodedRecipientFindings = runHardcodedRecipients(workflow);
  const deadEndBranchFindings = runDeadEndBranches(workflow);
  const postSendFindings = runPostSendObservability(workflow);
  const idempotencyFindings = runIdempotency(workflow);
  const timeoutFindings = runTimeouts(workflow);
  const subworkflowLoopFindings = runSubworkflowLoop(workflow);

  const all = [
    ...errorFindings,
    ...suppressionFindings,
    ...authFindings,
    ...webhookFindings,
    ...hardcodedRecipientFindings,
    ...deadEndBranchFindings,
    ...postSendFindings,
    ...idempotencyFindings,
    ...timeoutFindings,
    ...subworkflowLoopFindings,
  ];
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
