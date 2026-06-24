// Zod schemas for n8n workflow JSON.
//
// n8n exports two related shapes: the canonical workflow (active or saved) and
// the export envelope (result of "Download" from the editor). This module accepts
// both and normalizes downstream consumers onto a single shape.
//
// The schemas are deliberately lenient on unknown fields. n8n adds keys across
// versions; the audit only depends on structural pieces (nodes, connections,
// credentials, parameters). Unknown extras pass through untouched.

import { z } from "zod";

export const N8nCredentialRefSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
});

export const N8nNodeSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
    type: z.string(),
    typeVersion: z.union([z.number(), z.string()]).optional(),
    disabled: z.boolean().optional(),
    notes: z.string().optional(),
    notesInFlow: z.boolean().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    credentials: z.record(z.string(), N8nCredentialRefSchema).optional(),
    onError: z.string().optional(),
    continueOnFail: z.boolean().optional(),
    retryOnFail: z.boolean().optional(),
    position: z
      .union([
        z.tuple([z.number(), z.number()]),
        z.array(z.number()),
      ])
      .optional(),
  })
  .passthrough();

export type N8nNode = z.infer<typeof N8nNodeSchema>;

// A connection target: { node, type, index }.
export const N8nConnectionTargetSchema = z
  .object({
    node: z.string(),
    type: z.string(),
    index: z.number().optional(),
  })
  .passthrough();

// connections shape: { [sourceNodeName]: { [outputType]: Array<Array<Target>> } }
// outputType is typically "main" or "error". Inner array index = source output
// branch (e.g. IF-node has [[true-targets], [false-targets]]).
export const N8nConnectionsSchema = z.record(
  z.string(),
  z.record(z.string(), z.array(z.array(N8nConnectionTargetSchema))),
);

export type N8nConnections = z.infer<typeof N8nConnectionsSchema>;

export const N8nWorkflowSchema = z
  .object({
    name: z.string().optional(),
    id: z.union([z.string(), z.number()]).optional(),
    active: z.boolean().optional(),
    nodes: z.array(N8nNodeSchema),
    connections: N8nConnectionsSchema.default({}),
    settings: z.record(z.string(), z.unknown()).optional(),
    staticData: z.unknown().optional(),
    pinData: z.record(z.string(), z.unknown()).nullish().default({}),
    versionId: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).nullish().default({}),
    tags: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type N8nWorkflow = z.infer<typeof N8nWorkflowSchema>;

// n8n's editor export wraps the workflow in either { workflowData: {...} } or
// returns the workflow directly. Try the unwrap first, fall back to direct.
export function parseWorkflow(raw: unknown): N8nWorkflow {
  if (raw && typeof raw === "object" && "workflowData" in raw) {
    const inner = (raw as { workflowData: unknown }).workflowData;
    return N8nWorkflowSchema.parse(inner);
  }
  return N8nWorkflowSchema.parse(raw);
}

export function parseWorkflowJSON(json: string): N8nWorkflow {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Workflow JSON is not valid JSON: ${msg}`);
  }
  return parseWorkflow(raw);
}

// Build a fast lookup: node name -> node.
export function indexNodes(workflow: N8nWorkflow): Map<string, N8nNode> {
  const map = new Map<string, N8nNode>();
  for (const node of workflow.nodes) {
    map.set(node.name, node);
  }
  return map;
}

// Returns true if the node has at least one outgoing connection on the given
// output type ("main" / "error"). Errors silently if the node name is unknown.
export function hasOutgoing(
  workflow: N8nWorkflow,
  nodeName: string,
  outputType: "main" | "error" = "main",
): boolean {
  const branches = workflow.connections?.[nodeName]?.[outputType];
  if (!branches) return false;
  for (const branch of branches) {
    if (branch && branch.length > 0) return true;
  }
  return false;
}

// Returns the set of node names that the given source connects into via the
// given output type, flattening across branch indices.
export function downstreamNames(
  workflow: N8nWorkflow,
  nodeName: string,
  outputType: "main" | "error" = "main",
): string[] {
  const out = new Set<string>();
  const branches = workflow.connections?.[nodeName]?.[outputType];
  if (!branches) return [];
  for (const branch of branches) {
    if (!branch) continue;
    for (const target of branch) {
      if (target?.node) out.add(target.node);
    }
  }
  return [...out];
}

// Returns all nodes that point INTO the given target node via any output
// (main or error). Used to detect "is there an IF-node upstream".
export function upstreamNames(
  workflow: N8nWorkflow,
  targetName: string,
): string[] {
  const out = new Set<string>();
  for (const [src, byType] of Object.entries(workflow.connections ?? {})) {
    for (const branches of Object.values(byType ?? {})) {
      for (const branch of branches ?? []) {
        for (const target of branch ?? []) {
          if (target?.node === targetName) out.add(src);
        }
      }
    }
  }
  return [...out];
}
