// R9 - Hardcoded recipient lists.
//
// Send nodes should not carry literal recipient arrays or comma-separated
// recipient lists. Those lists drift, leak boundaries, and bypass registries.

import type { N8nNode, N8nWorkflow } from "../n8n-types.js";
import type { Finding } from "../types.js";
import { isSendNode } from "./shared.js";

const RECIPIENT_KEYS = [
  "to",
  "cc",
  "bcc",
  "email",
  "emails",
  "recipient",
  "recipients",
  "phone",
  "phones",
  "phoneNumber",
  "phoneNumbers",
  "chatId",
  "channel",
  "channels",
];

function isExpression(value: string): boolean {
  return value.trim().startsWith("={{") || value.includes("$json") || value.includes("$node");
}

function literalRecipientCount(value: unknown): number {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string" && !isExpression(item)).length;
  }
  if (typeof value !== "string") return 0;
  if (isExpression(value)) return 0;
  if (value.includes(",") || value.includes(";")) {
    return value.split(/[;,]/).filter((part) => part.trim().length > 0).length;
  }
  return 0;
}

function inspectObject(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  let count = 0;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (RECIPIENT_KEYS.includes(key)) count += literalRecipientCount(child);
    if (Array.isArray(child)) {
      for (const item of child) count += inspectObject(item);
    } else if (child && typeof child === "object") {
      count += inspectObject(child);
    }
  }
  return count;
}

function hardcodedRecipientCount(node: N8nNode): number {
  return inspectObject(node.parameters ?? {});
}

export function runHardcodedRecipients(workflow: N8nWorkflow): Finding[] {
  const findings: Finding[] = [];

  for (const node of workflow.nodes) {
    if (node.disabled) continue;
    if (!isSendNode(node)) continue;

    const count = hardcodedRecipientCount(node);
    if (count < 2) continue;

    findings.push({
      rule: "R9.hardcoded-recipients",
      severity: "medium",
      node_id: node.id ?? null,
      node_name: node.name,
      message: `Send action "${node.name}" contains ${count} hardcoded recipient values. Literal recipient lists drift and can bypass suppression or client-boundary registries.`,
      fix_hint:
        "Move recipients into Airtable, Postgres, environment config, or a scoped registry. The send node should read recipients from data, not carry a static list.",
    });
  }

  return findings;
}
