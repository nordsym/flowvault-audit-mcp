# Install FlowVault Audit MCP in Claude Desktop

## One-shot install

1. Download `flowvault-audit.mcpb` from `https://flowvault.se` (or grab `mcpb/dist/flowvault-audit.mcpb` from this repo).
2. Double-click the file.
3. Claude Desktop opens the Extensions sheet. Click **Install**.
4. (Optional) Fill in **n8n base URL** and **n8n API key**.
   - If you fill them in, every chat can immediately call `audit_all_n8n_workflows` against your instance.
   - Leave them blank if you only want the paste-JSON workflow tool. You can still call `connect_n8n` later in any chat.
5. Approve the prompt that the extension will run a local Node process. No network access required for the paste-JSON tool. The n8n tools talk to whichever n8n base URL you provide.

The extension is now active in every Claude Desktop chat.

## Generate an n8n API key

In your n8n instance:

1. Settings -> API.
2. **Create new API key**. Give it a name like `flowvault-audit`.
3. Scope it to read access on workflows (n8n cloud handles this automatically).
4. Copy the key into the Claude Desktop config sheet.

The key never leaves your machine. FlowVault Audit MCP only uses it to call your own n8n base URL.

## Use it

### Paste-JSON

> Audit this n8n workflow.
>
> ```json
> { "name": "...", "nodes": [...] }
> ```

### Whole-instance sweep

> Audit every workflow on my n8n. Show me the worst three.

Claude will call `audit_all_n8n_workflows`. The response is a worst-first table with grades and finding counts. Drill in with:

> Show me the full report for workflow `<id>`.

### Mid-chat connection

If you didn't set env vars on install:

> Connect to my n8n at `https://my-n8n.example.com` with API key `n8n_api_...`.

That call (`connect_n8n`) verifies the credentials by listing one workflow, then stores them for the rest of the session.

## Verify install

In a chat:

> What MCP tools do you have access to?

Claude lists `audit_workflow`, `connect_n8n`, `list_n8n_workflows`, `audit_n8n_workflow`, `audit_all_n8n_workflows`. If they're not there, restart Claude Desktop.

## Privacy

- The MCP server is a local stdio process. There is no NordSym proxy.
- The paste-JSON workflow tool runs entirely in-process; nothing leaves your machine.
- The n8n REST tools call **your own n8n base URL** with the API key you provided. The traffic goes from your machine to your n8n; FlowVault Audit MCP is never in the middle.
- The audit core is deterministic: same workflow JSON, same report. No LLM judgement, no API key for any inference provider.

Code path you can verify yourself: `mcpb/server/index.js` -> `mcpb/server/compiled/server.js` -> `audit.js` and `n8n-client.js`. Both are short, single-file, dependency-light.

## Uninstall

Settings -> Extensions -> FlowVault Audit -> Remove.

## Build from source

```bash
git clone https://github.com/nordsym/flowvault-audit-mcp
cd flowvault-audit-mcp
npm install
npm run build
npm test          # 12-fixture audit matrix + n8n REST integration test
npm run bundle    # produces mcpb/dist/flowvault-audit.mcpb
```
