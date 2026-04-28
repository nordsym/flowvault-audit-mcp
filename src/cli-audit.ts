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
    return;
  }
  process.stdout.write((markdown ?? "") + "\n");
  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error("[flowvault-audit] fatal:", err);
  process.exit(1);
});
