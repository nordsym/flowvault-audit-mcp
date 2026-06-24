// R11 - Post-send observability.
//
// After a send action, the workflow should write a proof signal: Airtable row,
// database insert, Notion log, Slack/Telegram internal alert, or similar.

import type { N8nNode, N8nWorkflow } from "../n8n-types.js";
import type { Finding } from "../types.js";
import { isSendNode, reachesNodeType, nodeBlob } from "./shared.js";

function isEvidenceNode(node: N8nNode): boolean {
  if (/^n8n-nodes-base\.(airtable|postgres|mysql|mongoDb|notion|googleSheets)$/.test(node.type)) {
    return true;
  }
  if (/^n8n-nodes-base\.(slack|telegram)$/.test(node.type)) {
    const blob = nodeBlob(node);
    return /log|audit|sent|proof|receipt|evidence|notify|alert/.test(blob);
  }
  return /log|audit|sent|proof|receipt|evidence/.test(nodeBlob(node));
}

export function runPostSendObservability(workflow: N8nWorkflow): Finding[] {
  const findings: Finding[] = [];

  for (const node of workflow.nodes) {
    if (node.disabled) continue;
    if (!isSendNode(node)) continue;
    if (isEvidenceNode(node)) continue;

    const hasEvidence = reachesNodeType(workflow, node.name, isEvidenceNode, 6);
    if (hasEvidence) continue;

    findings.push({
      rule: "R11.post-send-observability",
      severity: "medium",
      node_id: node.id ?? null,
      node_name: node.name,
      message: `Send action "${node.name}" has no downstream evidence write on its success path. After the fact, the operator may not be able to prove the send happened.`,
      fix_hint:
        "Add a post-send log write to Airtable, Postgres, Notion, Google Sheets, or an internal alert channel with recipient, timestamp, provider response, and correlation id.",
    });
  }

  return findings;
}
