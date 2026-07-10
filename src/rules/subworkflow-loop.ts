// R7 - Sub-workflow loop detection.
//
// executeWorkflow nodes can recurse: a workflow that calls itself (directly,
// or via a dynamic expression id) has no built-in depth limit in n8n and can
// fork executions until the instance falls over. Cross-workflow cycles cannot
// be resolved from a single workflow JSON, so those stay out of scope here;
// self-reference and dynamic ids are what we can prove locally.

import type { N8nWorkflow } from "../n8n-types.js";
import type { Finding } from "../types.js";

function extractWorkflowIdParam(params: Record<string, unknown> | undefined): string | null {
  if (!params) return null;
  const raw = params["workflowId"];
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    // Newer n8n stores { __rl: true, value, mode } resource-locator shape.
    const v = (raw as Record<string, unknown>)["value"];
    if (typeof v === "string") return v;
  }
  return null;
}

export function runSubworkflowLoop(workflow: N8nWorkflow): Finding[] {
  const findings: Finding[] = [];
  const selfId = workflow.id !== undefined ? String(workflow.id) : null;

  for (const node of workflow.nodes) {
    if (node.disabled) continue;
    if (!/^n8n-nodes-base\.executeWorkflow$/.test(node.type)) continue;

    const targetId = extractWorkflowIdParam(node.parameters);

    if (targetId && selfId && targetId === selfId) {
      findings.push({
        rule: "R7.subworkflow-loop",
        severity: "high",
        node_id: node.id ?? null,
        node_name: node.name,
        message: `"${node.name}" executes this same workflow (id ${selfId}). n8n has no recursion depth limit; this can fork executions until the instance is exhausted.`,
        fix_hint:
          "Add an explicit depth guard: pass a depth counter in the sub-workflow input and stop (IF node) above a hard limit. Or restructure so the loop body is a SplitInBatches iteration instead of self-invocation.",
      });
      continue;
    }

    if (targetId && /\{\{/.test(targetId)) {
      findings.push({
        rule: "R7.subworkflow-loop",
        severity: "medium",
        node_id: node.id ?? null,
        node_name: node.name,
        message: `"${node.name}" chooses its sub-workflow with a dynamic expression (${targetId.slice(0, 60)}). Recursion cannot be ruled out statically and no depth guard is visible.`,
        fix_hint:
          "If the expression can ever resolve to this workflow or to a caller of it, pass and check a depth counter. Otherwise pin the workflowId statically.",
      });
    }
  }

  return findings;
}
