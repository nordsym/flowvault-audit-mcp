#!/usr/bin/env node
// Live integration test for the n8n REST API tools.
//
// Spins up a tiny in-process HTTP server that mimics the n8n REST surface
// (GET /api/v1/workflows + GET /api/v1/workflows/:id) and serves the local
// fixtures as if they were stored in a real n8n instance. Then drives the
// full MCP tool flow: connect_n8n -> list_n8n_workflows -> audit_n8n_workflow
// -> audit_all_n8n_workflows.
//
// This proves the network path works end-to-end without needing a real n8n.

import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { ping, listWorkflows, getWorkflow, normalizeBaseUrl } from "./n8n-client.js";
import { auditAll, auditWorkflowById } from "./audit-instance.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "../fixtures");

const FAKE_KEY = "n8n_test_api_key_abcd1234";

interface FakeWorkflow {
  id: string;
  name: string;
  active: boolean;
  body: unknown;
}

function loadFixturesAsWorkflows(): FakeWorkflow[] {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  const out: FakeWorkflow[] = [];
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, f), "utf8"));
    // The editor-export envelope wraps the workflow; unwrap for storage.
    const wf = raw.workflowData ?? raw;
    const id = basename(f, ".json");
    out.push({
      id,
      name: wf.name ?? id,
      active: wf.active ?? false,
      body: wf,
    });
  }
  return out;
}

function startFakeN8n(workflows: FakeWorkflow[]): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolveStart) => {
    const server = createServer((req, res) => {
      const auth = req.headers["x-n8n-api-key"];
      if (auth !== FAKE_KEY) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "unauthorized" }));
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/api/v1/workflows") {
        const activeOnly = url.searchParams.get("active") === "true";
        const filtered = activeOnly ? workflows.filter((w) => w.active) : workflows;
        const data = filtered.map((w) => ({
          id: w.id,
          name: w.name,
          active: w.active,
          updatedAt: "2026-04-28T00:00:00.000Z",
          tags: [],
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data, nextCursor: null }));
        return;
      }
      const m = url.pathname.match(/^\/api\/v1\/workflows\/([^/]+)$/);
      if (req.method === "GET" && m) {
        const id = decodeURIComponent(m[1]);
        const wf = workflows.find((w) => w.id === id);
        if (!wf) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(wf.body));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "no route" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Bad listen address");
      const url = `http://127.0.0.1:${addr.port}`;
      resolveStart({
        url,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function main() {
  const workflows = loadFixturesAsWorkflows();
  const fake = await startFakeN8n(workflows);
  const cfg = { baseUrl: normalizeBaseUrl(fake.url), apiKey: FAKE_KEY };

  console.log("\nFlowVault Audit MCP - n8n REST integration test\n");

  const failures: string[] = [];

  // 1. Bad auth probe.
  const badPing = await ping({ baseUrl: cfg.baseUrl, apiKey: "wrong_key" });
  if (badPing.ok || badPing.error.kind !== "auth") {
    failures.push(`expected auth error on bad key, got: ${JSON.stringify(badPing)}`);
  } else {
    console.log("  ✓ wrong api key -> auth error");
  }

  // 2. Good ping.
  const goodPing = await ping(cfg);
  if (!goodPing.ok) failures.push(`ping failed: ${JSON.stringify(goodPing)}`);
  else console.log(`  ✓ ping ok (${goodPing.value.count} workflow visible in probe)`);

  // 3. List workflows.
  const list = await listWorkflows(cfg);
  if (!list.ok) failures.push(`list failed: ${JSON.stringify(list)}`);
  else console.log(`  ✓ list returned ${list.value.length} workflow(s)`);

  // 4. Single fetch + audit (Bortforsla buggy -> not-ready).
  const single = await auditWorkflowById(cfg, "bortforsla-send-buggy");
  if (!single.ok) {
    failures.push(`single audit failed: ${single.error}`);
  } else if (single.report.grade !== "not-ready") {
    failures.push(`single audit: expected not-ready, got ${single.report.grade}`);
  } else {
    console.log(`  ✓ audit_n8n_workflow(bortforsla-send-buggy) -> ${single.report.grade_emoji} ${single.report.grade}, ${single.report.summary.total} findings`);
  }

  // 5. Single fetch + audit fixed (production-ready).
  const fixed = await auditWorkflowById(cfg, "bortforsla-send-fixed");
  if (!fixed.ok) {
    failures.push(`fixed audit failed: ${fixed.error}`);
  } else if (fixed.report.grade !== "production-ready") {
    failures.push(`fixed audit: expected production-ready, got ${fixed.report.grade}`);
  } else {
    console.log(`  ✓ audit_n8n_workflow(bortforsla-send-fixed) -> ${fixed.report.grade_emoji} ${fixed.report.grade}`);
  }

  // 6. Portfolio audit.
  const port = await auditAll(cfg);
  if (!port.ok) {
    failures.push(`portfolio failed: ${port.error}`);
  } else {
    const p = port.portfolio;
    const expectedTotal = workflows.length;
    if (p.total_workflows !== expectedTotal) {
      failures.push(`portfolio: expected ${expectedTotal} workflows, got ${p.total_workflows}`);
    }
    if (p.errored !== 0) failures.push(`portfolio: ${p.errored} workflows errored`);
    // Worst-first ordering: index 0 must be a not-ready (or error).
    const worst = p.worst_first[0];
    if (!worst || (worst.grade !== "not-ready" && worst.grade !== "error")) {
      failures.push(`portfolio: worst_first[0] should be not-ready/error, got ${worst?.grade}`);
    }
    console.log(
      `  ✓ audit_all_n8n_workflows -> ${p.audited}/${p.total_workflows} audited, dist: ${JSON.stringify(p.grade_distribution)}, worst: ${worst?.grade_emoji} ${worst?.workflow_name}`,
    );
  }

  // 7. 404 on unknown id.
  const missing = await getWorkflow(cfg, "does-not-exist");
  if (missing.ok || missing.error.kind !== "not_found") {
    failures.push(`expected not_found, got: ${JSON.stringify(missing)}`);
  } else {
    console.log("  ✓ unknown workflow id -> not_found error");
  }

  await fake.close();

  console.log("");
  if (failures.length > 0) {
    for (const f of failures) console.log("  FAIL", f);
    console.log(`\n${failures.length} failure(s).\n`);
    process.exit(1);
  }
  console.log("All n8n REST integration checks passed.\n");
}

main().catch((err) => {
  console.error("[test-instance] fatal:", err);
  process.exit(1);
});
