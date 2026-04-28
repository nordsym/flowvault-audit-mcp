# Install FlowVault Audit MCP in Claude Desktop

## One-shot install

1. Download `flowvault-audit.mcpb` from `https://flowvault.se` (or grab `mcpb/dist/flowvault-audit.mcpb` from this repo).
2. Double-click the file.
3. Claude Desktop opens the Extensions sheet. Click **Install**.
4. Approve the prompt that the extension will run a local Node process. No network access required.

The extension is now active in every Claude Desktop chat.

## Use it

In any chat:

> Audit this n8n workflow.
>
> ```json
> { "name": "...", "nodes": [...], "connections": {...} }
> ```

Claude calls the `audit_workflow` tool. You get back a graded report (🟢 / 🟡 / 🔴) plus per-node findings and fix hints.

## Verify install

In a chat:

> What MCP tools do you have access to?

Claude lists `audit_workflow` (FlowVault Audit). If it isn't there, restart Claude Desktop.

## Privacy

The MCP server is a local stdio process. The workflow JSON you paste:

- Stays on your machine.
- Is parsed by the bundled server (`node server/index.js`).
- Is never uploaded.

Code: `mcpb/server/index.js` -> `mcpb/server/compiled/server.js`. Audit logic: deterministic, rule-based. No LLM call, no API call, no telemetry.

## Uninstall

Settings -> Extensions -> FlowVault Audit -> Remove.

## Build from source

```bash
git clone https://github.com/nordsym/flowvault-audit-mcp
cd flowvault-audit-mcp
npm install
npm run build
npm test
npm run bundle    # produces mcpb/dist/flowvault-audit.mcpb
```
