// R5 - Timeout configuration.
//
// Long-running HTTP / LLM / DB nodes with no explicit timeout can hang an
// execution indefinitely, hold queue slots, and stall downstream sends.
// Informational hygiene severity: it rarely breaks alone, but it compounds
// every other failure mode.

import type { N8nNode, N8nWorkflow } from "../n8n-types.js";
import type { Finding } from "../types.js";

const TIMEOUT_SENSITIVE_TYPES: Array<{ type: RegExp; label: string }> = [
  { type: /^n8n-nodes-base\.httpRequest$/, label: "HTTP request" },
  { type: /^n8n-nodes-base\.(postgres|mySql|microsoftSql|mongoDb)$/, label: "database" },
  { type: /^n8n-nodes-base\.graphql$/, label: "GraphQL" },
  { type: /langchain\.(openAi|lmChat|agent|chainLlm)/i, label: "LLM" },
  { type: /^n8n-nodes-base\.openAi$/, label: "LLM" },
];

function hasExplicitTimeout(node: N8nNode): boolean {
  const params = node.parameters ?? {};
  const direct = (params as Record<string, unknown>)["timeout"];
  if (typeof direct === "number" && direct > 0) return true;
  if (typeof direct === "string" && direct.trim() !== "") return true;
  const options = (params as Record<string, unknown>)["options"];
  if (options && typeof options === "object") {
    const t = (options as Record<string, unknown>)["timeout"];
    if (typeof t === "number" && t > 0) return true;
    if (typeof t === "string" && t.trim() !== "") return true;
    const rt = (options as Record<string, unknown>)["requestTimeout"];
    if (typeof rt === "number" && rt > 0) return true;
  }
  return false;
}

export function runTimeouts(workflow: N8nWorkflow): Finding[] {
  const findings: Finding[] = [];

  for (const node of workflow.nodes) {
    if (node.disabled) continue;
    const match = TIMEOUT_SENSITIVE_TYPES.find((p) => p.type.test(node.type));
    if (!match) continue;
    if (hasExplicitTimeout(node)) continue;

    findings.push({
      rule: "R5.timeouts",
      severity: "low",
      node_id: node.id ?? null,
      node_name: node.name,
      message: `${match.label} node "${node.name}" has no explicit timeout. A slow upstream can hang this execution and everything queued behind it.`,
      fix_hint:
        "Set an explicit timeout in the node options (HTTP: options.timeout; LLM/DB: the node's timeout option). Pick the longest duration you would accept in production, not the default of unlimited.",
    });
  }

  return findings;
}
