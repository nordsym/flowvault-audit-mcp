// R8 - Webhook respond shape.
//
// Webhook entrypoints should reach a Respond to Webhook node on the main path.
// Without this, callers can hang or receive n8n defaults instead of the
// workflow's intended API contract.

import type { N8nWorkflow } from "../n8n-types.js";
import type { Finding } from "../types.js";
import { reachesNodeType } from "./shared.js";

function isWebhook(nodeType: string): boolean {
  return /^n8n-nodes-base\.webhook$/.test(nodeType);
}

function isRespondToWebhook(nodeType: string): boolean {
  return /^n8n-nodes-base\.respondToWebhook$/.test(nodeType);
}

export function runWebhookRespondShape(workflow: N8nWorkflow): Finding[] {
  const findings: Finding[] = [];

  for (const node of workflow.nodes) {
    if (node.disabled) continue;
    if (!isWebhook(node.type)) continue;

    const reachesRespond = reachesNodeType(
      workflow,
      node.name,
      (candidate) => isRespondToWebhook(candidate.type),
    );
    if (reachesRespond) continue;

    findings.push({
      rule: "R8.webhook-respond-shape",
      severity: workflow.active ? "high" : "medium",
      node_id: node.id ?? null,
      node_name: node.name,
      message: `Webhook entrypoint "${node.name}" does not reach a Respond to Webhook node on its main path. API callers can hang or receive an unintended default response.`,
      fix_hint:
        "Add a Respond to Webhook node on every successful webhook path, and wire error paths to an explicit error response.",
    });
  }

  return findings;
}
