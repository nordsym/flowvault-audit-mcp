#!/usr/bin/env node
// FlowVault Audit MCP server.
//
// Stdio MCP server exposing one tool, `audit_workflow`, that runs three
// deterministic reliability checks on raw n8n workflow JSON. Workflow JSON
// never leaves the user's machine - this process exits the moment the parent
// (Claude Desktop) closes the stdio pipe.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { auditWithMarkdown } from "./audit.js";

const PRODUCT_NAME = "flowvault-audit-mcp";
const PRODUCT_VERSION = "0.1.0";

async function main() {
  const server = new McpServer(
    {
      name: PRODUCT_NAME,
      version: PRODUCT_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "FlowVault Audit MCP. Call audit_workflow with a raw n8n workflow JSON export. Returns a structured reliability audit covering error path coverage, suppression-check pre-send, and auth drift. Workflow JSON stays local; no network calls.",
    },
  );

  server.registerTool(
    "audit_workflow",
    {
      title: "Audit n8n workflow",
      description:
        "Audit an n8n workflow JSON export for three reliability gaps: error path coverage, suppression-check pre-send, and auth drift. Returns a structured report with severity-ranked findings, fix hints, and a Production-Ready grade (🟢 / 🟡 / 🔴).",
      inputSchema: {
        workflow: z
          .string()
          .min(1)
          .describe(
            "Raw n8n workflow JSON. Either the canonical workflow shape or the editor 'Download' export envelope (`{workflowData: ...}`) is accepted.",
          ),
      },
    },
    async (args) => {
      const { result, markdown } = auditWithMarkdown(args.workflow);
      const text = markdown ?? "FlowVault Audit MCP returned no markdown.";
      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
        structuredContent: result.ok
          ? { ok: true, report: result.report }
          : { ok: false, error: result.error },
        isError: !result.ok,
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // Write to stderr so it appears in Claude Desktop's MCP logs.
  console.error("[flowvault-audit-mcp] fatal:", err);
  process.exit(1);
});
