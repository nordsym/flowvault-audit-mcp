// R1 - Error path coverage.
//
// For every node that can fail at runtime (network calls, integrations, code
// nodes), flag if there is no outgoing connection on the error branch AND the
// node is not configured with continueOnFail / onError handling.
//
// This is the rule that catches "silent failure" - the workflow proceeds as if
// the failed node returned empty data, which downstream nodes then operate on,
// often producing wrong but green-looking executions.

import type { N8nNode, N8nWorkflow } from "../n8n-types.js";
import { hasOutgoing, downstreamNames } from "../n8n-types.js";
import type { Finding } from "../types.js";

// Node types that can fail in production. List is conservative - we'd rather
// false-positive on a Code node than miss a Gmail send.
const FAILABLE_TYPE_PREFIXES = [
  "n8n-nodes-base.httpRequest",
  "n8n-nodes-base.gmail",
  "n8n-nodes-base.airtable",
  "n8n-nodes-base.slack",
  "n8n-nodes-base.notion",
  "n8n-nodes-base.openAi",
  "n8n-nodes-base.code",
  "n8n-nodes-base.function",
  "n8n-nodes-base.functionItem",
  "n8n-nodes-base.executeWorkflow",
  "n8n-nodes-base.webhook",
  "n8n-nodes-base.respondToWebhook",
  "n8n-nodes-base.postgres",
  "n8n-nodes-base.mysql",
  "n8n-nodes-base.mongoDb",
  "n8n-nodes-base.redis",
  "n8n-nodes-base.s3",
  "n8n-nodes-base.googleDrive",
  "n8n-nodes-base.googleSheets",
  "n8n-nodes-base.stripe",
  "n8n-nodes-base.twilio",
  "n8n-nodes-base.smtp",
  "n8n-nodes-base.ftp",
  "n8n-nodes-base.ssh",
  "@n8n/n8n-nodes-langchain",
];

// Node types that are pure transforms or triggers - no error branch needed.
const NON_FAILABLE_TYPE_PREFIXES = [
  "n8n-nodes-base.set",
  "n8n-nodes-base.merge",
  "n8n-nodes-base.if",
  "n8n-nodes-base.switch",
  "n8n-nodes-base.filter",
  "n8n-nodes-base.splitInBatches",
  "n8n-nodes-base.itemLists",
  "n8n-nodes-base.aggregate",
  "n8n-nodes-base.compareDatasets",
  "n8n-nodes-base.dateTime",
  "n8n-nodes-base.crypto",
  "n8n-nodes-base.editImage",
  "n8n-nodes-base.html",
  "n8n-nodes-base.markdown",
  "n8n-nodes-base.noOp",
  "n8n-nodes-base.wait",
  "n8n-nodes-base.cron",
  "n8n-nodes-base.scheduleTrigger",
  "n8n-nodes-base.manualTrigger",
  "n8n-nodes-base.start",
  "n8n-nodes-base.stickyNote",
];

function isFailable(type: string): boolean {
  if (NON_FAILABLE_TYPE_PREFIXES.some((p) => type.startsWith(p))) return false;
  if (FAILABLE_TYPE_PREFIXES.some((p) => type.startsWith(p))) return true;
  // Default to failable for unknown integration nodes.
  return type.startsWith("n8n-nodes-base.") && !type.endsWith(".set");
}

function isHandled(node: N8nNode): boolean {
  if (node.continueOnFail === true) return true;
  // n8n added `onError` with values like "continueErrorOutput" / "continueRegularOutput"
  // / "stopWorkflow". Anything other than the default counts as explicit handling
  // when paired with an actual error branch (checked separately).
  return false;
}

function isTerminalNode(workflow: N8nWorkflow, node: N8nNode): boolean {
  // No downstream main targets at all.
  return !hasOutgoing(workflow, node.name, "main");
}

export function runErrorCoverage(workflow: N8nWorkflow): Finding[] {
  const findings: Finding[] = [];
  for (const node of workflow.nodes) {
    if (node.disabled) continue;
    if (!isFailable(node.type)) continue;
    if (isHandled(node)) continue;

    const hasErrorBranch = hasOutgoing(workflow, node.name, "error");
    if (hasErrorBranch) continue;

    const terminal = isTerminalNode(workflow, node);
    const downstream = downstreamNames(workflow, node.name, "main");

    let severity: Finding["severity"];
    let message: string;
    if (terminal) {
      // Failable terminal nodes (last-step send / write actions) silently lose
      // observability when they fail. Treat as high.
      severity = "high";
      message = `Failable terminal node "${node.name}" (${node.type}) has no error branch. Failures will be silent.`;
    } else if (downstream.length > 0) {
      // Failable mid-workflow nodes leak into downstream logic with no signal.
      severity = "medium";
      message = `Failable node "${node.name}" (${node.type}) has no error branch. ${downstream.length} downstream node(s) will receive empty / wrong data on failure.`;
    } else {
      severity = "low";
      message = `Failable node "${node.name}" (${node.type}) has no error branch.`;
    }

    findings.push({
      rule: "R1.error-coverage",
      severity,
      node_id: node.id ?? null,
      node_name: node.name,
      message,
      fix_hint:
        "Add an error output connection from this node, or set onError to continueErrorOutput, or wire continueOnFail with explicit downstream handling.",
    });
  }
  return findings;
}
