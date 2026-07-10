// R4 - Idempotency / dedupe.
//
// Automated triggers (webhook, schedule, cron, pollers) that reach a send
// action with no dedupe-looking step in between risk duplicate side effects
// under retries, replays, or concurrent runs.

import type { N8nWorkflow } from "../n8n-types.js";
import type { Finding } from "../types.js";
import { isSendNode, nodeBlob, reachesNodeType } from "./shared.js";

const AUTOMATED_TRIGGER_TYPES =
  /^n8n-nodes-base\.(webhook|scheduleTrigger|cron|interval|emailReadImap|rssFeedRead(Trigger)?)$|Trigger$/;

// manualTrigger and executeWorkflowTrigger are operator/parent-driven; a human
// or the calling workflow owns dedupe there.
const EXEMPT_TRIGGER_TYPES = /^n8n-nodes-base\.(manualTrigger|executeWorkflowTrigger)$/;

const DEDUPE_KEYWORDS = [
  "dedup",
  "idempot",
  "already sent",
  "already processed",
  "alreadysent",
  "seen",
  "processed",
  "upsert",
  "unique key",
  "dedupekey",
  "removeduplicates",
];

function isDedupeishNode(blob: string, nodeType: string): boolean {
  if (/n8n-nodes-base\.removeDuplicates$/.test(nodeType)) return true;
  return DEDUPE_KEYWORDS.some((kw) => blob.includes(kw));
}

export function runIdempotency(workflow: N8nWorkflow): Finding[] {
  const findings: Finding[] = [];

  for (const node of workflow.nodes) {
    if (node.disabled) continue;
    if (EXEMPT_TRIGGER_TYPES.test(node.type)) continue;
    if (!AUTOMATED_TRIGGER_TYPES.test(node.type)) continue;

    const reachesSend = reachesNodeType(workflow, node.name, (c) => isSendNode(c));
    if (!reachesSend) continue;

    const hasDedupe = reachesNodeType(workflow, node.name, (c) =>
      isDedupeishNode(nodeBlob(c), c.type),
    );
    if (hasDedupe) continue;

    const isWebhook = /^n8n-nodes-base\.webhook$/.test(node.type);
    findings.push({
      rule: "R4.idempotency",
      severity: isWebhook && workflow.active ? "medium" : "low",
      node_id: node.id ?? null,
      node_name: node.name,
      message: `Trigger "${node.name}" reaches a send action with no dedupe step in between. Retries, replays, or concurrent deliveries can produce duplicate sends.`,
      fix_hint:
        "Add a dedupe key check before the send: look up a processed-marker (execution id, message id, or record hash) in a store (Airtable/Postgres/Redis) and skip when already seen. Or use a Remove Duplicates node keyed on a stable id.",
    });
  }

  return findings;
}
