#!/usr/bin/env node
// Local CLI runner: `npm run audit -- path/to/workflow.json [--json]`
//
// Useful for piping fixtures through the audit without spinning up the MCP
// transport. Same audit core, same report shape.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditWithMarkdown } from "./audit.js";

function usage(): never {
  console.error("Usage: flowvault-audit <workflow.json> [--json]");
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();
  const wantJson = args.includes("--json");
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) usage();
  const fullPath = resolve(process.cwd(), path);
  const json = readFileSync(fullPath, "utf8");
  const { result, markdown } = auditWithMarkdown(json);
  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write((markdown ?? "") + "\n");
  }
  // Exit code doubles as a shell-friendly grade gate (used by the Curator):
  // 0 production-ready, 1 conditional, 2 not-ready, 3 invalid input.
  if (!result.ok) process.exit(3);
  const grade = result.report.grade;
  process.exit(grade === "production-ready" ? 0 : grade === "conditional" ? 1 : 2);
}

main().catch((err) => {
  console.error("[flowvault-audit] fatal:", err);
  process.exit(1);
});
