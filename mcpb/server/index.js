#!/usr/bin/env node
// FlowVault Audit MCP entry for Claude Desktop Extension (.mcpb).
// The compiled server ships in ./compiled (copied from project dist/ at bundle
// time). Node modules ship under ./node_modules. The MCP server is local stdio
// only - no network, no telemetry, no upload.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
await import(resolve(here, "compiled", "server.js"));
