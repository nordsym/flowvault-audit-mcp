// R3 - Auth drift.
//
// Flags credential references at risk of staleness or rotation gaps. Only the
// workflow JSON is in scope (the user's full credential list is not), so the
// rule operates on signals visible inside the export:
//
// - Credentials whose name or id contains drift markers like "legacy", "old",
//   "deprecated", "test", "tmp", "backup". HIGH.
// - Credentials with a name that has no rotation hint (no date pattern, no
//   "rotated" / "fresh" keyword). LOW info, since it might still be fine but
//   the operator has no visibility.
// - Credentials referenced multiple times across the workflow with conflicting
//   name labels for the same id. MEDIUM (drift between editor sessions).

import type { N8nNode, N8nWorkflow } from "../n8n-types.js";
import type { Finding } from "../types.js";

interface CredRef {
  field: string;
  id?: string;
  name?: string;
  node: N8nNode;
}

const DRIFT_MARKERS = [
  "legacy",
  "old",
  "deprecated",
  "tmp",
  "temp",
  "test",
  "backup",
  "v1-old",
  "do-not-use",
  "donotuse",
  "stale",
  "rotate-me",
  "rotateme",
];

const ROTATION_HINT_RE =
  /(rotated|rotate|rotation|fresh|new|\b20\d{2}-\d{2}(-\d{2})?\b|\bq[1-4]\b)/i;

function collectCredRefs(workflow: N8nWorkflow): CredRef[] {
  const refs: CredRef[] = [];
  for (const node of workflow.nodes) {
    if (!node.credentials) continue;
    for (const [field, ref] of Object.entries(node.credentials)) {
      refs.push({ field, id: ref.id, name: ref.name, node });
    }
  }
  return refs;
}

function hasDriftMarker(text: string | undefined): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const marker of DRIFT_MARKERS) {
    if (lower.includes(marker)) return marker;
  }
  return null;
}

export function runAuthDrift(workflow: N8nWorkflow): Finding[] {
  const findings: Finding[] = [];
  const refs = collectCredRefs(workflow);
  if (refs.length === 0) return findings;

  // 1. Drift-marker pass.
  for (const ref of refs) {
    const markerInName = hasDriftMarker(ref.name);
    const markerInId = hasDriftMarker(ref.id);
    const marker = markerInName ?? markerInId;
    if (!marker) continue;
    findings.push({
      rule: "R3.auth-drift",
      severity: "high",
      node_id: ref.node.id ?? null,
      node_name: ref.node.name,
      message: `Node "${ref.node.name}" references credential "${ref.name ?? ref.id ?? ref.field}" containing drift marker "${marker}". This credential is flagged as legacy / temporary / test / deprecated.`,
      fix_hint:
        "Rotate to a current credential, or remove the drift marker from the credential name once rotation is complete. Stale auth is the most common silent-failure source under load.",
    });
  }

  // 2. Conflicting-name pass: same id used with different names.
  const idToNames = new Map<string, Set<string>>();
  for (const ref of refs) {
    if (!ref.id) continue;
    const names = idToNames.get(ref.id) ?? new Set<string>();
    if (ref.name) names.add(ref.name);
    idToNames.set(ref.id, names);
  }
  for (const [id, names] of idToNames) {
    if (names.size > 1) {
      const sample = refs.find((r) => r.id === id)!;
      findings.push({
        rule: "R3.auth-drift",
        severity: "medium",
        node_id: sample.node.id ?? null,
        node_name: sample.node.name,
        message: `Credential id "${id}" is referenced under conflicting display names: ${[...names].map((n) => `"${n}"`).join(", ")}. Editor sessions have drifted; rotation status is ambiguous.`,
        fix_hint:
          "Open n8n credentials, confirm canonical name, then re-attach all referencing nodes so the workflow JSON is internally consistent.",
      });
    }
  }

  // 3. Rotation-hint pass: name with no rotation signal at all.
  const seenIds = new Set<string>();
  for (const ref of refs) {
    if (!ref.id) continue;
    if (seenIds.has(ref.id)) continue;
    seenIds.add(ref.id);
    if (hasDriftMarker(ref.name) || hasDriftMarker(ref.id)) continue;
    if (ref.name && ROTATION_HINT_RE.test(ref.name)) continue;
    findings.push({
      rule: "R3.auth-drift",
      severity: "low",
      node_id: ref.node.id ?? null,
      node_name: ref.node.name,
      message: `Credential "${ref.name ?? ref.id}" on node "${ref.node.name}" has no rotation hint in its name. Operators cannot tell at a glance when this credential was last rotated.`,
      fix_hint:
        "Add a rotation tag to the credential name, e.g. \"Gmail Bortforsla (rotated 2026-04-01)\". This is a convention NordSym uses to keep auth drift visible without external tooling.",
    });
  }

  return findings;
}
