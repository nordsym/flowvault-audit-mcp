#!/usr/bin/env node
// FlowVault Audit MCP entry for Claude Desktop Extension (.mcpb).
// The compiled server ships in ./compiled (copied from project dist/ at bundle
// time). Node modules ship under ./node_modules. The MCP server is local stdio
// only - no network, no telemetry, no upload.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
try {
  await import(resolve(here, "compiled", "server.js"));
} catch (err) {
  if (err && (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND")) {
    console.error(
      "[flowvault-audit-mcp] Startup failed: a dependency could not be resolved.\n" +
        "  " + (err.message || String(err)) + "\n" +
        "  The bundled extension ships its own node_modules. If this is a source checkout, run `npm install` (then `npm run build`) in the project root before launching dist/server.js.",
    );
    process.exit(1);
  }
  throw err;
}
