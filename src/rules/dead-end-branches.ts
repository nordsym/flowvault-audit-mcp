// R10 - Dead-end branches.
//
// IF and Switch branches with no downstream target silently drop work. That is
// acceptable only when the branch is intentionally wired to a no-op or logger.

import type { N8nWorkflow } from "../n8n-types.js";
import type { Finding } from "../types.js";

function isBranchingNode(type: string): boolean {
  return /^n8n-nodes-base\.(if|switch)$/.test(type);
}

function expectedBranchCount(type: string): number {
  if (/^n8n-nodes-base\.if$/.test(type)) return 2;
  return 1;
}

export function runDeadEndBranches(workflow: N8nWorkflow): Finding[] {
  const findings: Finding[] = [];

  for (const node of workflow.nodes) {
    if (node.disabled) continue;
    if (!isBranchingNode(node.type)) continue;

    const branches = workflow.connections?.[node.name]?.main ?? [];
    const minBranches = expectedBranchCount(node.type);
    const totalBranches = Math.max(minBranches, branches.length);

    for (let i = 0; i < totalBranches; i += 1) {
      const branch = branches[i] ?? [];
      if (branch.length > 0) continue;
      findings.push({
        rule: "R10.dead-end-branches",
        severity: "medium",
        node_id: node.id ?? null,
        node_name: node.name,
        message: `Branch ${i} of "${node.name}" has no downstream target. Items on that path are silently dropped.`,
        fix_hint:
          "Wire the branch to a no-op, log, response, or explicit terminal node so the drop is intentional and auditable.",
      });
    }
  }

  return findings;
}
