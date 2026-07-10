#!/usr/bin/env node
// FlowVault Audit MCP server.
//
// Stdio MCP server. Two surfaces, same audit core:
//
//   1. Paste-JSON workflow:
//        audit_workflow({ workflow })
//
//   2. Talk to the user's own n8n instance via the n8n REST API:
//        connect_n8n({ base_url, api_key })
//        list_n8n_workflows({ active_only?, limit? })
//        audit_n8n_workflow({ workflow_id })
//        audit_all_n8n_workflows({ active_only?, limit?, include_reports? })
//
// Credentials live in the user's MCP config (Claude Desktop env vars or
// per-call args). All n8n calls leave from the user's machine to their own
// n8n. FlowVault Audit MCP never proxies through a NordSym endpoint.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { auditWithMarkdown } from "./audit.js";
import { ping } from "./n8n-client.js";
import {
  envSnapshot,
  getConnection,
  getConnectionSource,
  redactApiKey,
  resolveConfig,
  seedFromEnv,
  setConnection,
} from "./n8n-state.js";
import { listWorkflows } from "./n8n-client.js";
import {
  auditAll,
  auditWorkflowById,
  renderPortfolioMarkdown,
} from "./audit-instance.js";
import { renderMarkdown } from "./report.js";
import {
  readLicenseKeyFromEnv,
  redactLicenseKey,
  requireTier,
  verifyLicense,
} from "./license.js";
import {
  auditExecutionsForWorkflow,
  executionHealth,
  renderExecutionHealthMarkdown,
  renderExecutionMarkdown,
} from "./execution-audit.js";

const PRODUCT_NAME = "flowvault-audit-mcp";
const PRODUCT_VERSION = "0.4.0";

function configMissing(): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { ok: false; error: { error: string; detail: string } };
  isError: true;
} {
  return {
    content: [
      {
        type: "text",
        text: "No n8n connection. Call `connect_n8n` first with your n8n base URL and API key, or set N8N_BASE_URL and N8N_API_KEY env vars.",
      },
    ],
    structuredContent: {
      ok: false,
      error: {
        error: "no_connection",
        detail:
          "FlowVault Audit MCP has no n8n connection. Run connect_n8n({base_url, api_key}) or set the N8N_BASE_URL + N8N_API_KEY env vars in your MCP config.",
      },
    },
    isError: true,
  };
}

async function main() {
  seedFromEnv();

  const server = new McpServer(
    {
      name: PRODUCT_NAME,
      version: PRODUCT_VERSION,
    },
    {
      capabilities: { tools: {} },
      instructions:
        "FlowVault Audit MCP. Three surfaces: (1) audit_workflow({workflow}) for raw JSON paste, (2) connect_n8n + list_n8n_workflows + audit_n8n_workflow + audit_all_n8n_workflows for structural audits against the user's own n8n instance via its REST API, (3) audit_n8n_executions + execution_health for execution evidence: did recent runs actually deliver (error rate, dead triggers, green-but-empty runs where a send node never executed, unhandled error paths), with a flowvault.receipt/v1 evidence receipt per inspected run. Workflow JSON and execution data stay local; the only outbound traffic is from the user's machine to the user's own n8n.",
    },
  );

  // ─── Tool 1: paste-JSON audit ─────────────────────────────────────────────
  server.registerTool(
    "audit_workflow",
    {
      title: "Audit n8n workflow JSON",
      description:
        "Audit an n8n workflow JSON export for error path coverage, suppression-check pre-send, and auth drift. Returns a structured reliability report with severity-ranked findings, fix hints, and a Production-Ready grade. Use this when the user pastes workflow JSON directly. For audits across the user's whole n8n instance, use audit_all_n8n_workflows.",
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
      return {
        content: [{ type: "text", text: markdown ?? "FlowVault Audit MCP returned no markdown." }],
        structuredContent: result.ok
          ? { ok: true, report: result.report }
          : { ok: false, error: result.error },
        isError: !result.ok,
      };
    },
  );

  // ─── Tool 2: connect to the user's n8n instance ───────────────────────────
  server.registerTool(
    "connect_n8n",
    {
      title: "Connect to an n8n instance",
      description:
        "Store the user's n8n base URL and API key for the rest of the session. Verifies the credentials by listing one workflow. The credentials live only in this MCP server process; nothing is uploaded.",
      inputSchema: {
        base_url: z
          .string()
          .min(1)
          .describe("n8n base URL, e.g. https://n8n.example.com or https://yourname.app.n8n.cloud."),
        api_key: z
          .string()
          .min(1)
          .describe("n8n API key with read access to /api/v1/workflows. Generated in n8n Settings -> API."),
      },
    },
    async (args) => {
      const cfg = setConnection(args.base_url, args.api_key);
      const probe = await ping(cfg);
      if (!probe.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to authenticate against ${cfg.baseUrl}: ${probe.error.message}`,
            },
          ],
          structuredContent: { ok: false, error: probe.error },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Connected to ${cfg.baseUrl}. API key ${redactApiKey(cfg.apiKey)} accepted. Ready for list_n8n_workflows / audit_n8n_workflow / audit_all_n8n_workflows.`,
          },
        ],
        structuredContent: {
          ok: true,
          base_url: cfg.baseUrl,
          api_key_redacted: redactApiKey(cfg.apiKey),
        },
      };
    },
  );

  // ─── Tool 3: list workflows on the connected instance ─────────────────────
  server.registerTool(
    "list_n8n_workflows",
    {
      title: "List workflows on the connected n8n instance",
      description:
        "List workflow id + name + active status from the connected n8n instance. Use this to discover which workflow_id to pass to audit_n8n_workflow. Pagination is handled internally up to `limit`.",
      inputSchema: {
        active_only: z
          .boolean()
          .optional()
          .describe("If true, only workflows currently activated in n8n are returned. Defaults to false."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("Maximum number of workflows to return. Defaults to 1000."),
        base_url: z
          .string()
          .optional()
          .describe("Optional override - n8n base URL for this call only. Falls back to the stored connection or env vars."),
        api_key: z
          .string()
          .optional()
          .describe("Optional override - n8n API key for this call only."),
      },
    },
    async (args) => {
      const cfg = resolveConfig({ base_url: args.base_url, api_key: args.api_key });
      if (!cfg) return configMissing();
      const res = await listWorkflows(cfg, { activeOnly: args.active_only, limit: args.limit });
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Failed to list workflows: ${res.error.message}` }],
          structuredContent: { ok: false, error: res.error },
          isError: true,
        };
      }
      const lines: string[] = [
        `# Workflows on ${cfg.baseUrl}`,
        "",
        `Total: ${res.value.length}`,
        "",
        "| Active | id | Name |",
        "|--------|----|------|",
      ];
      for (const w of res.value) {
        const name = w.name.replace(/\|/g, "\\|");
        lines.push(`| ${w.active ? "🟢" : "⚪"} | \`${w.id}\` | ${name} |`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: { ok: true, workflows: res.value },
      };
    },
  );

  // ─── Tool 4: audit one workflow on the connected instance ─────────────────
  server.registerTool(
    "audit_n8n_workflow",
    {
      title: "Audit one workflow from the connected n8n instance",
      description:
        "Fetch a single workflow from the connected n8n instance by id and run the deterministic three-rule audit (error coverage, suppression check, auth drift). Returns the same structured report shape as audit_workflow.",
      inputSchema: {
        workflow_id: z
          .string()
          .min(1)
          .describe("n8n workflow id (the value shown in the n8n editor URL or returned by list_n8n_workflows)."),
        base_url: z
          .string()
          .optional()
          .describe("Optional override - n8n base URL for this call only."),
        api_key: z
          .string()
          .optional()
          .describe("Optional override - n8n API key for this call only."),
      },
    },
    async (args) => {
      const cfg = resolveConfig({ base_url: args.base_url, api_key: args.api_key });
      if (!cfg) return configMissing();
      const res = await auditWorkflowById(cfg, args.workflow_id);
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Failed to audit workflow ${args.workflow_id}: ${res.error}` }],
          structuredContent: { ok: false, error: { error: "audit_failed", detail: res.error } },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: renderMarkdown(res.report) }],
        structuredContent: { ok: true, report: res.report, workflow_id: args.workflow_id },
      };
    },
  );

  // ─── Diagnostic: show what the running server has loaded ─────────────────
  server.registerTool(
    "flowvault_status",
    {
      title: "FlowVault Audit MCP status",
      description:
        "Diagnostic. Reports the running server version, n8n connection state, and FlowVault license tier (pro/free/none). Use this when something is not working to confirm the server has the credentials you expect.",
      inputSchema: {},
    },
    async () => {
      const cfg = getConnection();
      const env = envSnapshot();
      const licenseKey = readLicenseKeyFromEnv();
      const license = await verifyLicense();
      const lines: string[] = [
        `# FlowVault Audit MCP status`,
        "",
        `**Version:** ${PRODUCT_VERSION}`,
        `**License tier:** ${license.tier ?? "none"}${license.valid ? "" : " (invalid)"}`,
        `**License key:** ${licenseKey ? redactLicenseKey(licenseKey) : "(not set)"}`,
        `**License source:** ${license.source}`,
        `**Connection source:** ${getConnectionSource()}`,
        `**Connected:** ${cfg ? "yes" : "no"}`,
      ];
      if (cfg) {
        lines.push(`**n8n base URL:** ${cfg.baseUrl}`);
        lines.push(`**n8n API key:** ${redactApiKey(cfg.apiKey)}`);
      }
      lines.push("");
      lines.push("## Env vars seen by the MCP process");
      lines.push("");
      lines.push(
        `- N8N_BASE_URL set: ${env.N8N_BASE_URL_set}${env.N8N_BASE_URL_value ? ` (${env.N8N_BASE_URL_value})` : ""}`,
      );
      lines.push(`- N8N_API_KEY set: ${env.N8N_API_KEY_set}`);
      lines.push(`- FLOWVAULT_LICENSE_KEY set: ${!!licenseKey}`);
      lines.push("");
      if (license.error) {
        lines.push(`## License diagnostic`);
        lines.push("");
        lines.push(`- Error: ${license.error}`);
        lines.push("");
      }
      if (!cfg || !license.valid) {
        lines.push("## What to do");
        lines.push("");
        if (!license.valid) {
          lines.push(
            "- Pro tools (portfolio sweeps) need an active license. Get one at https://flowvault.se/pro and paste the key into the FlowVault Audit extension settings.",
          );
        }
        if (!cfg) {
          lines.push(
            "- If the n8n env vars above show as `false`, Claude Desktop did not pipe user_config values into the MCP process. After filling them, toggle the extension off/on to respawn with new env.",
          );
          lines.push(
            "- Or call `connect_n8n({base_url, api_key})` directly to set them for the current session.",
          );
        }
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          ok: true,
          version: PRODUCT_VERSION,
          connected: !!cfg,
          source: getConnectionSource(),
          base_url: cfg?.baseUrl ?? null,
          api_key_redacted: cfg ? redactApiKey(cfg.apiKey) : null,
          env: env,
          license: {
            valid: license.valid,
            tier: license.tier,
            source: license.source,
            key_redacted: licenseKey ? redactLicenseKey(licenseKey) : null,
            email_redacted: license.email_redacted ?? null,
            error: license.error ?? null,
            cached: license.cached,
          },
        },
      };
    },
  );

  // ─── Tool 5: audit ALL workflows (portfolio) [PRO] ────────────────────────
  server.registerTool(
    "audit_all_n8n_workflows",
    {
      title: "Audit every workflow on the connected n8n instance [PRO]",
      description:
        "[PRO] Iterate every workflow on the connected n8n instance, run the deterministic audit on each, and return a portfolio report sorted worst-first. One-shot reliability sweep across an entire n8n installation. Requires a FlowVault Pro license key (set in extension settings). Get one at https://flowvault.se/pro. Pagination handled internally.",
      inputSchema: {
        active_only: z
          .boolean()
          .optional()
          .describe("If true, only workflows currently activated in n8n are audited. Defaults to false."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("Cap on the number of workflows to audit. Defaults to 1000."),
        include_reports: z
          .boolean()
          .optional()
          .describe("If true, the per-workflow full report is embedded in structuredContent. Defaults to false to keep payloads small."),
        base_url: z
          .string()
          .optional()
          .describe("Optional override - n8n base URL for this call only."),
        api_key: z
          .string()
          .optional()
          .describe("Optional override - n8n API key for this call only."),
      },
    },
    async (args) => {
      const gate = await requireTier("pro");
      if (!gate.ok) {
        return {
          content: [
            {
              type: "text",
              text:
                gate.message ??
                "FlowVault Pro license required for portfolio sweeps.",
            },
          ],
          structuredContent: {
            ok: false,
            error: {
              error: "tier_required",
              required_tier: "pro",
              current_tier: gate.status.tier,
              license_valid: gate.status.valid,
              upgrade_url: "https://flowvault.se/pro",
            },
          },
          isError: true,
        };
      }
      const cfg = resolveConfig({ base_url: args.base_url, api_key: args.api_key });
      if (!cfg) return configMissing();
      const res = await auditAll(cfg, {
        activeOnly: args.active_only,
        limit: args.limit,
        includeReports: args.include_reports,
      });
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Portfolio audit failed: ${res.error}` }],
          structuredContent: { ok: false, error: { error: "portfolio_failed", detail: res.error } },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: renderPortfolioMarkdown(res.portfolio) }],
        structuredContent: { ok: true, portfolio: res.portfolio },
      };
    },
  );

  // ─── Tool 6: execution-evidence audit for one workflow ───────────────────
  server.registerTool(
    "audit_n8n_executions",
    {
      title: "Audit recent executions of one workflow (green-but-wrong check)",
      description:
        "Grade what a workflow's recent runs ACTUALLY did, not what the JSON promises. Pulls the last N executions from the connected n8n instance and checks: error rate (E1), dead/stuck active workflows (E2), green-but-empty runs where a send node never executed despite status success (E3), and failures with no error path (E4). Returns findings plus one flowvault.receipt/v1 evidence receipt per inspected execution. Complements audit_n8n_workflow, which audits structure.",
      inputSchema: {
        workflow_id: z
          .string()
          .min(1)
          .describe("n8n workflow id whose execution history should be audited."),
        lookback: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("How many recent executions to inspect. Defaults to 20."),
        base_url: z.string().optional().describe("Optional override - n8n base URL for this call only."),
        api_key: z.string().optional().describe("Optional override - n8n API key for this call only."),
      },
    },
    async (args) => {
      const cfg = resolveConfig({ base_url: args.base_url, api_key: args.api_key });
      if (!cfg) return configMissing();
      const res = await auditExecutionsForWorkflow(cfg, args.workflow_id, { lookback: args.lookback });
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Failed to audit executions for ${args.workflow_id}: ${res.error}` }],
          structuredContent: { ok: false, error: { error: "execution_audit_failed", detail: res.error } },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: renderExecutionMarkdown(res.analysis) }],
        structuredContent: {
          ok: true,
          analysis: {
            workflow_id: res.analysis.workflow_id,
            workflow_name: res.analysis.workflow_name,
            active: res.analysis.active,
            window: res.analysis.window,
            counts: res.analysis.counts,
            findings: res.analysis.findings,
          },
          receipts: res.analysis.receipts,
        },
      };
    },
  );

  // ─── Tool 7: execution health across the instance [PRO] ──────────────────
  server.registerTool(
    "execution_health",
    {
      title: "Execution health sweep across the connected n8n instance [PRO]",
      description:
        "[PRO] Sweep every workflow's recent execution history and rank them worst-first by execution evidence: failure rate, dead active triggers, stuck runs, and unhandled error paths. This is the runtime companion to audit_all_n8n_workflows (which audits structure). Requires a FlowVault Pro license key. For the per-run green-but-empty check and receipts, follow up with audit_n8n_executions on a specific workflow.",
      inputSchema: {
        active_only: z
          .boolean()
          .optional()
          .describe("If true, only active workflows are swept. Defaults to false."),
        lookback: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Executions inspected per workflow. Defaults to 20."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("Cap on the number of workflows swept. Defaults to 1000."),
        base_url: z.string().optional().describe("Optional override - n8n base URL for this call only."),
        api_key: z.string().optional().describe("Optional override - n8n API key for this call only."),
      },
    },
    async (args) => {
      const gate = await requireTier("pro");
      if (!gate.ok) {
        return {
          content: [
            {
              type: "text",
              text: gate.message ?? "FlowVault Pro license required for portfolio sweeps.",
            },
          ],
          structuredContent: {
            ok: false,
            error: {
              error: "tier_required",
              required_tier: "pro",
              current_tier: gate.status.tier,
              license_valid: gate.status.valid,
              upgrade_url: "https://flowvault.se/pro",
            },
          },
          isError: true,
        };
      }
      const cfg = resolveConfig({ base_url: args.base_url, api_key: args.api_key });
      if (!cfg) return configMissing();
      const res = await executionHealth(cfg, {
        activeOnly: args.active_only,
        lookback: args.lookback,
        limit: args.limit,
      });
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Execution health sweep failed: ${res.error}` }],
          structuredContent: { ok: false, error: { error: "execution_health_failed", detail: res.error } },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: renderExecutionHealthMarkdown(res.report) }],
        structuredContent: { ok: true, report: res.report },
      };
    },
  );

  const stored = getConnection();
  if (stored) {
    // Surfaces in Claude Desktop's MCP server logs.
    console.error(
      `[flowvault-audit-mcp] seeded n8n connection: ${stored.baseUrl} (key ${redactApiKey(stored.apiKey)})`,
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[flowvault-audit-mcp] fatal:", err);
  process.exit(1);
});
