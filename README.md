# FlowVault Audit MCP

Deterministic reliability audit for n8n. Ships as a Claude Desktop Extension (`.mcpb`). Two surfaces, same audit core: paste workflow JSON, or connect to your own n8n instance and sweep every workflow.

Workflow data never leaves your machine. The audit is rules, not LLM judgement.

Part of the FlowVault reliability layer.

## Five tools

| Tool | What it does |
|------|--------------|
| `audit_workflow({workflow})` | Audit a raw n8n workflow JSON paste. |
| `connect_n8n({base_url, api_key})` | Verify and store an n8n REST connection for the session. |
| `list_n8n_workflows({active_only?, limit?})` | List workflow id + name + active state from the connected instance. |
| `audit_n8n_workflow({workflow_id})` | Fetch one workflow from the connected instance and audit it. |
| `audit_all_n8n_workflows({active_only?, limit?})` | Sweep every workflow on the connected instance. Returns a worst-first portfolio report. |

## Three rules

| Rule | What it catches |
|------|-----------------|
| R1 - Error path coverage | Failable nodes (HTTP, Gmail, Code, integrations) with no error branch. |
| R2 - Suppression check pre-send | Outbound workflows missing a suppression / DNC / unsubscribe gate before the send, OR an IF gate wired with the matched-suppression branch reaching the send (the Bortforsla 2026-04-24 inversion shape). |
| R3 - Auth drift | Stale credential references (legacy / test / deprecated markers), credentials with conflicting display names for the same id, and credentials missing a rotation hint. |

Each finding carries `rule`, `severity`, `node_id`, `node_name`, `message`, and an actionable `fix_hint`. The report rolls up to a Production-Ready grade: 🟢 / 🟡 / 🔴.

## Privacy

- The MCP server is a local Node stdio process spawned by Claude Desktop.
- The paste-JSON tool runs entirely in-process. Nothing leaves your machine.
- The n8n REST tools call your own n8n instance directly from your machine, using the credentials you provide. There is no NordSym proxy.
- No telemetry. No logging beyond the local stdio channel Claude Desktop already shows you.

## Install (Claude Desktop)

1. Download `flowvault-audit.mcpb` from `https://flowvault.se` or `mcpb/dist/flowvault-audit.mcpb` in this repo.
2. Double-click. Claude Desktop opens the Extensions sheet. Click **Install**.
3. (Optional) Enter your n8n base URL and API key in the config sheet so the audit can sweep your instance without re-authenticating every chat. The fields are optional - leave blank to use only the paste-JSON tool.

See [INSTALL.md](./INSTALL.md) for screenshots and recovery paths.

## Use it

### Paste-JSON

> Audit this n8n workflow.
>
> ```json
> { "name": "...", "nodes": [...], "connections": {...} }
> ```

### Sweep your n8n

If you set the env vars on install, just say:

> Audit every workflow on my n8n. Show me the worst ones first.

Claude calls `audit_all_n8n_workflows`. You get back a portfolio table with grades, finding counts, and the worst workflow at the top. Drill in with:

> Show me the full audit for `<workflow_id>`.

If you skipped the env vars, prime the connection once per session:

> Connect to my n8n at `https://my-n8n.example.com` with API key `n8n_api_...`.

## Build from source

```bash
git clone https://github.com/nordsym/flowvault-audit-mcp
cd flowvault-audit-mcp
npm install
npm run build
npm test          # 12-fixture audit matrix + n8n REST integration test
npm run audit -- fixtures/bortforsla-send-buggy.json
npm run bundle    # produces mcpb/dist/flowvault-audit.mcpb
```

## Repo layout

```
src/
  server.ts             MCP stdio entry; registers 5 tools
  n8n-client.ts         n8n REST API client (X-N8N-API-KEY)
  n8n-state.ts          in-process connection state (env-seeded, override-aware)
  audit.ts              orchestrator (parse + 3 rules + report)
  audit-instance.ts     portfolio orchestrator + markdown render
  cli-audit.ts          local CLI runner
  audit/
    n8n-types.ts        zod schema for n8n workflow JSON
    report.ts           report formatter + grading
    rules/
      error-coverage.ts  R1
      suppression-check.ts R2
      auth-drift.ts      R3
  test.ts               12-fixture audit matrix
  test-instance.ts      stub-n8n integration test
fixtures/               n8n workflow shapes spanning Bortforsla case + 11 others
mcpb/
  manifest.json         Claude Desktop Extension manifest (manifest_version 0.3)
  build.sh              packages mcpb/dist/flowvault-audit.mcpb
  server/index.js       thin entry that imports compiled/server.js
```

## Roadmap

Sprint 1 (this version): paste-JSON + n8n REST connection + portfolio sweep.

Later sprints per the FlowVault PRD:
- Web endpoint at `flowvault.se/audit` for users without Claude Desktop.
- Production-Ready stamp on the existing FlowVault catalog.
- Reliability bundles (hybrid orchestration, push-over-poll, suppression-list, NDR scanner).
- Operator playbook.
- LLM gloss on the deterministic core.
- Managed tier.

## License

MIT.
