import type {
  N8nConnectionTargetSchema,
  N8nNode,
  N8nWorkflow,
} from "../n8n-types.js";
import { z } from "zod";

type Target = z.infer<typeof N8nConnectionTargetSchema>;

const SEND_TYPE_PATTERNS: Array<{ type: RegExp }> = [
  { type: /^n8n-nodes-base\.gmail$/ },
  { type: /^n8n-nodes-base\.smtp$/ },
  { type: /^n8n-nodes-base\.emailSend$/ },
  { type: /^n8n-nodes-base\.sendGrid$/ },
  { type: /^n8n-nodes-base\.mailgun$/ },
  { type: /^n8n-nodes-base\.postmark$/ },
  { type: /^n8n-nodes-base\.twilio$/ },
  { type: /^n8n-nodes-base\.slack$/ },
  { type: /^n8n-nodes-base\.discord$/ },
  { type: /^n8n-nodes-base\.telegram$/ },
  { type: /^n8n-nodes-base\.whatsApp$/ },
];

const SEND_OPERATION_KEYWORDS = ["send", "post", "create", "reply", "broadcast"];

export function isSendNode(node: N8nNode): boolean {
  for (const pattern of SEND_TYPE_PATTERNS) {
    if (!pattern.type.test(node.type)) continue;
    const op = String(node.parameters?.operation ?? "send").toLowerCase();
    if (SEND_OPERATION_KEYWORDS.some((kw) => op.includes(kw)) || op === "send") {
      return true;
    }
    if (!node.parameters?.operation) return true;
  }
  return false;
}

export function buildOutgoing(workflow: N8nWorkflow) {
  const map = new Map<
    string,
    Array<{ branchIndex: number; outputType: string; target: Target }>
  >();
  for (const [src, byType] of Object.entries(workflow.connections ?? {})) {
    const list = map.get(src) ?? [];
    for (const [outputType, branches] of Object.entries(byType ?? {})) {
      branches.forEach((branch, branchIndex) => {
        for (const target of branch ?? []) {
          list.push({ branchIndex, outputType, target });
        }
      });
    }
    map.set(src, list);
  }
  return map;
}

export function reachesNodeType(
  workflow: N8nWorkflow,
  startName: string,
  predicate: (node: N8nNode) => boolean,
  maxHops = 12,
): boolean {
  const byName = new Map(workflow.nodes.map((node) => [node.name, node]));
  const outgoing = buildOutgoing(workflow);
  const queue: Array<{ name: string; hops: number }> = [{ name: startName, hops: 0 }];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.hops > maxHops) continue;
    if (seen.has(cur.name)) continue;
    seen.add(cur.name);

    const node = byName.get(cur.name);
    if (node && cur.hops > 0 && !node.disabled && predicate(node)) return true;

    for (const edge of outgoing.get(cur.name) ?? []) {
      if (edge.outputType !== "main") continue;
      queue.push({ name: edge.target.node, hops: cur.hops + 1 });
    }
  }

  return false;
}

export function nodeBlob(node: N8nNode): string {
  return [
    node.name,
    node.type,
    node.notes ?? "",
    JSON.stringify(node.parameters ?? {}),
  ]
    .join(" ")
    .toLowerCase();
}
