# FlowVault Audit MCP

Deterministic reliability audit for n8n workflow JSON. Ships as a Claude Desktop Extension (`.mcpb`) so the workflow JSON never leaves the user's machine.

Part of the FlowVault reliability layer.

## What it does

One MCP tool: `audit_workflow({ workflow: string })`.

Pass any n8n workflow export. Get back a structured report with three deterministic checks:

| Rule | What it catches |
|------|-----------------|
| R1 - Error path coverage | Failable nodes (HTTP, Gmail, Code, integrations) with no error branch |
| R2 - Suppression check pre-send | Outbound workflows missing a suppression / DNC / unsubscribe gate before the send |
| R3 - Auth drift | Stale credential references and credentials with no rotation hint |

Each finding carries `rule`, `severity`, `node_id`, `node_name`, and a `fix_hint` you can act on. The report rolls up to a Production-Ready grade per the FlowVault PRD: 🟢 / 🟡 / 🔴.

## Why deterministic

The audit core is rules, not LLM judgement. Same input, same output, every time. An LLM gloss layer is on the FlowVault PRD roadmap (sprint 6) but the wedge ships without it.

## Install (Claude Desktop)

1. Download `flowvault-audit.mcpb` from `flowvault.se` (or build it locally with `npm run bundle`).
2. Double-click the file. Claude Desktop installs the extension.
3. In any Claude Desktop chat: "Audit this n8n workflow:" + paste your JSON. Claude calls the `audit_workflow` tool.

The MCP server is a Node stdio process. No network calls, no upload, no telemetry.

## Build from source

```bash
npm install
npm run build       # tsc -> dist/
npm run dev         # tsx run for development
npm run audit -- fixtures/bortforsla-send-buggy.json   # one-shot CLI
npm run bundle      # produce mcpb/dist/flowvault-audit.mcpb
```

## Inspector

```bash
npx @modelcontextprotocol/inspector dist/server.js
```

Lists `audit_workflow`. Stub-call with `{"workflow": "{}"}` returns a clean report.

## Repo layout

```
src/
  server.ts             MCP stdio entry
  cli-audit.ts          local CLI runner
  audit.ts              orchestrator (parse + rules + report)
  n8n-types.ts          zod schema for n8n workflow JSON
  report.ts             report formatter + grading
  rules/
    error-coverage.ts   R1
    suppression-check.ts R2
    auth-drift.ts       R3
fixtures/
  bortforsla-send-buggy.json  buggy outbound shape (R2 fires)
  bortforsla-send-fixed.json  corrected version (R2 passes)
mcpb/
  manifest.json         Claude Desktop Extension manifest
  build.sh              packages mcpb/dist/flowvault-audit.mcpb
  server/index.js       thin entry that imports dist/server.js
```

## Sprint 1 scope

Sprint 1 ships the MCP only. Web endpoint, Production-Ready stamp, bundles, playbook, and managed tier are later sprints per the FlowVault PRD.

## License

MIT.
