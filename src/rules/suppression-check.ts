// R2 - Suppression check pre-send.
//
// For outbound-shaped workflows (anything ending in a send-action node),
// require an explicit IF / Filter / Switch upstream of the send that gates on
// a suppression list, unsubscribe, or DNC signal.
//
// Heuristic detection (deterministic, no LLM):
//
// - Find all "send action" nodes (Gmail send, SMTP, Slack post, Twilio SMS,
//   webhook respond etc.).
// - For each, walk upstream until a trigger or a depth limit. Collect every
//   IF / Switch / Filter ancestor.
// - Inspect the gate node parameters for suppression keywords.
// - If no suppression-keyword gate is found upstream of the send, flag CRITICAL
//   (this would have caught a workflow with no gate at all).
// - If a gate exists but its "matched" branch (true/index 0) reaches the send,
//   flag HIGH inverted-gate. This is the Bortforsla 2026-04-24 shape: the
//   matched-suppression branch fed straight into the send. Sends went silent
//   in the ways the operator least expected.
// - If an upstream gate exists and the unmatched branch reaches the send, the
//   shape is correct: pass.

import type {
  N8nConnectionTargetSchema,
  N8nNode,
  N8nWorkflow,
} from "../n8n-types.js";
import { indexNodes } from "../n8n-types.js";
import type { Finding } from "../types.js";
import { z } from "zod";

const SEND_TYPE_PATTERNS: Array<{ type: RegExp; opPath?: string[] }> = [
  { type: /^n8n-nodes-base\.gmail$/, opPath: ["operation"] },
  { type: /^n8n-nodes-base\.smtp$/ },
  { type: /^n8n-nodes-base\.emailSend$/ },
  { type: /^n8n-nodes-base\.sendGrid$/ },
  { type: /^n8n-nodes-base\.mailgun$/ },
  { type: /^n8n-nodes-base\.postmark$/ },
  { type: /^n8n-nodes-base\.twilio$/ },
  { type: /^n8n-nodes-base\.slack$/, opPath: ["operation"] },
  { type: /^n8n-nodes-base\.discord$/ },
  { type: /^n8n-nodes-base\.telegram$/ },
  { type: /^n8n-nodes-base\.whatsApp$/ },
];

// Operations that count as actually sending vs reading. If a node's operation
// is "search" / "get" / "list", it's not a send and we skip it.
const SEND_OPERATION_KEYWORDS = ["send", "post", "create", "reply", "broadcast"];

const SUPPRESSION_KEYWORDS = [
  "suppress",
  "unsub",
  "unsubscribe",
  "blocklist",
  "block_list",
  "blacklist",
  "denylist",
  "dnc",
  "do not contact",
  "do_not_contact",
  "opt-out",
  "opt_out",
  "optout",
  "bounced",
  "complain",
  "complaint",
];

const GATE_TYPE_PATTERNS = [
  /^n8n-nodes-base\.if$/,
  /^n8n-nodes-base\.switch$/,
  /^n8n-nodes-base\.filter$/,
];

type Target = z.infer<typeof N8nConnectionTargetSchema>;

function isSendNode(node: N8nNode): boolean {
  for (const pattern of SEND_TYPE_PATTERNS) {
    if (!pattern.type.test(node.type)) continue;
    // Some send-shaped nodes (gmail, slack) have non-send operations like
    // "getMessages". Filter those out.
    const op = (node.parameters?.operation as string | undefined) ?? "send";
    if (
      SEND_OPERATION_KEYWORDS.some((kw) =>
        op.toLowerCase().includes(kw),
      ) ||
      op === "send"
    ) {
      return true;
    }
    // Telegram, twilio, smtp etc. with no operation field default to send.
    if (!node.parameters?.operation) return true;
  }
  return false;
}

function isGateNode(node: N8nNode): boolean {
  return GATE_TYPE_PATTERNS.some((p) => p.test(node.type));
}

function gateBlob(node: N8nNode): string {
  const parts: string[] = [
    JSON.stringify(node.parameters ?? {}),
    node.name,
    node.notes ?? "",
  ];
  return parts.join(" ").toLowerCase();
}

function gateMentionsSuppression(node: N8nNode): boolean {
  const blob = gateBlob(node);
  return SUPPRESSION_KEYWORDS.some((kw) => blob.includes(kw));
}

// IF nodes have two outputs: index 0 = true (matched), index 1 = false.
// Filter nodes have only one output (passed). Switch nodes can have N. The
// "inversion is a smell" heuristic only makes sense for IF, where branch 0
// reaching the send means matched-suppression people get sent to.
function isIfNode(node: N8nNode): boolean {
  return /^n8n-nodes-base\.if$/.test(node.type);
}

// Returns map: source -> Array<{branchIndex, target}>.
function buildOutgoing(workflow: N8nWorkflow) {
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

// Returns map: target -> Array<{source, branchIndex}>.
function buildIncoming(workflow: N8nWorkflow) {
  const map = new Map<
    string,
    Array<{ source: string; branchIndex: number; outputType: string }>
  >();
  for (const [src, byType] of Object.entries(workflow.connections ?? {})) {
    for (const [outputType, branches] of Object.entries(byType ?? {})) {
      branches.forEach((branch, branchIndex) => {
        for (const target of branch ?? []) {
          const list = map.get(target.node) ?? [];
          list.push({ source: src, branchIndex, outputType });
          map.set(target.node, list);
        }
      });
    }
  }
  return map;
}

interface AncestorGate {
  gateNode: N8nNode;
  // The branch index on the gate that flows downstream into the send.
  branchIndex: number;
  // Hop distance from the send (1 = immediate parent).
  hops: number;
}

// Walk upstream from a send node, collecting all IF/Switch/Filter ancestors and
// the branch index by which they reach the send. Limited to 12 hops to bound
// cost on weird graphs.
function findUpstreamGates(
  workflow: N8nWorkflow,
  sendNode: N8nNode,
  incoming: ReturnType<typeof buildIncoming>,
  byName: Map<string, N8nNode>,
): AncestorGate[] {
  const gates: AncestorGate[] = [];
  const seen = new Set<string>();
  // Each frontier item: node we just stepped INTO from below, plus the branch
  // index by which it pushed data into the descendant chain that leads to the
  // send. For the immediate-incoming step, that's the branchIndex on the
  // source's outgoing connection.
  type Frontier = { name: string; viaBranch: number; hops: number };
  const queue: Frontier[] = [];
  for (const inc of incoming.get(sendNode.name) ?? []) {
    queue.push({ name: inc.source, viaBranch: inc.branchIndex, hops: 1 });
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.hops > 12) continue;
    if (seen.has(cur.name)) continue;
    seen.add(cur.name);
    const node = byName.get(cur.name);
    if (!node) continue;
    if (isGateNode(node)) {
      gates.push({ gateNode: node, branchIndex: cur.viaBranch, hops: cur.hops });
      // Don't traverse past a gate: callers care about the closest gate.
      continue;
    }
    for (const inc of incoming.get(cur.name) ?? []) {
      queue.push({ name: inc.source, viaBranch: inc.branchIndex, hops: cur.hops + 1 });
    }
  }
  return gates;
}

export function runSuppressionCheck(workflow: N8nWorkflow): Finding[] {
  const findings: Finding[] = [];
  const byName = indexNodes(workflow);
  const incoming = buildIncoming(workflow);

  const sends = workflow.nodes.filter((n) => !n.disabled && isSendNode(n));
  if (sends.length === 0) {
    // Not an outbound workflow. Rule does not apply.
    return findings;
  }

  for (const sendNode of sends) {
    const gates = findUpstreamGates(workflow, sendNode, incoming, byName);
    if (gates.length === 0) {
      findings.push({
        rule: "R2.suppression-check",
        severity: "critical",
        node_id: sendNode.id ?? null,
        node_name: sendNode.name,
        message: `Send action "${sendNode.name}" (${sendNode.type}) has no IF/Switch/Filter gate upstream. Workflow can fan-send to suppressed, bounced, or unsubscribed recipients with no preflight check.`,
        fix_hint:
          "Add an IF node directly upstream of the send. Compare the recipient against an authoritative suppression list (Airtable, Postgres, file). Route only the unmatched branch into the send.",
      });
      continue;
    }

    const suppressionGates = gates.filter((g) => gateMentionsSuppression(g.gateNode));

    if (suppressionGates.length === 0) {
      findings.push({
        rule: "R2.suppression-check",
        severity: "high",
        node_id: sendNode.id ?? null,
        node_name: sendNode.name,
        message: `Send action "${sendNode.name}" has an upstream gate ("${gates[0].gateNode.name}") but no suppression keyword in its conditions. Cannot deterministically confirm a suppression check is in place.`,
        fix_hint:
          "Rename the gate or include suppression / unsubscribe / DNC / blocklist in the condition so the gate's intent is auditable. The gate should compare each recipient against the canonical suppression source.",
      });
      continue;
    }

    // For each suppression gate, IF its matched-branch (index 0 by convention
    // for n8n IF; first output is the TRUE / matched output) reaches the send,
    // the connection is inverted: matched-suppression people get sent to.
    // This is the Bortforsla 2026-04-24 silent-block shape. Only applies to
    // IF nodes - Filter has one output, Switch has many and the per-branch
    // semantics depend on rule order.
    for (const g of suppressionGates) {
      if (!isIfNode(g.gateNode)) continue;
      if (g.branchIndex === 0) {
        findings.push({
          rule: "R2.suppression-check",
          severity: "high",
          node_id: sendNode.id ?? null,
          node_name: sendNode.name,
          message: `Send action "${sendNode.name}" is reached via the MATCHED branch (index 0) of upstream suppression gate "${g.gateNode.name}". Inverted wiring - recipients matched as suppressed are receiving sends, and unmatched recipients may be silently dropped.`,
          fix_hint: `Swap the connections on "${g.gateNode.name}". The matched (true / index 0) branch should route to a no-op or logging node. The unmatched (false / index 1) branch is the one that should reach "${sendNode.name}".`,
        });
      }
    }
  }

  return findings;
}
