#!/usr/bin/env node
// Execution-evidence test matrix.
//
// Feeds fixtures/executions/*.json through the pure analysis core
// (analyzeExecutions) and asserts findings + receipt verdicts. No network.
//
// Usage: tsx src/test-executions.ts (part of npm test)

import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeExecutions,
  parseExecutionDetail,
  ReceiptSchema,
  type ExecutionDetail,
} from "./execution-audit.js";
import { parseWorkflow } from "./n8n-types.js";
import type { N8nExecutionSummary } from "./n8n-client.js";
import type { ExecRuleId, Severity } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "../fixtures/executions");

interface ExecExpectation {
  fixture: string;
  mustFind: Array<{ rule: ExecRuleId; severity?: Severity; executionId?: string }>;
  mustNotFind?: Array<{ rule: ExecRuleId }>;
  receiptVerdicts?: Record<string, string>;
  receiptCount?: number;
}

const EXPECTATIONS: ExecExpectation[] = [
  {
    fixture: "exec-green-but-empty.json",
    mustFind: [{ rule: "E3.green-but-empty", severity: "high", executionId: "3003" }],
    mustNotFind: [{ rule: "E1.error-rate" }, { rule: "E2.silent-active" }],
    receiptVerdicts: { "3003": "silent-failure", "3002": "delivered", "3001": "delivered" },
    receiptCount: 3,
  },
  {
    fixture: "exec-error-rate.json",
    mustFind: [
      { rule: "E1.error-rate", severity: "critical" },
      { rule: "E4.unhandled-error-path", severity: "high" },
    ],
    mustNotFind: [{ rule: "E2.silent-active" }],
    receiptCount: 10,
  },
  {
    fixture: "exec-silent-active.json",
    mustFind: [{ rule: "E2.silent-active", severity: "high" }],
    mustNotFind: [{ rule: "E1.error-rate" }, { rule: "E3.green-but-empty" }],
    receiptCount: 0,
  },
  {
    fixture: "exec-clean.json",
    mustFind: [],
    mustNotFind: [
      { rule: "E1.error-rate" },
      { rule: "E2.silent-active" },
      { rule: "E3.green-but-empty" },
      { rule: "E4.unhandled-error-path" },
    ],
    receiptVerdicts: { "5002": "delivered", "5001": "delivered" },
    receiptCount: 2,
  },
];

let failures = 0;
function fail(msg: string) {
  failures += 1;
  console.error(`  FAIL ${msg}`);
}

for (const exp of EXPECTATIONS) {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, exp.fixture), "utf8"));
  const workflow = parseWorkflow(raw.workflow);
  const executions = raw.executions as N8nExecutionSummary[];
  const details = new Map<string, ExecutionDetail>();
  for (const [id, detailRaw] of Object.entries(raw.details ?? {})) {
    const parsed = parseExecutionDetail(detailRaw);
    if (parsed) details.set(id, parsed);
  }
  const now = new Date(raw.now);

  const analysis = analyzeExecutions(workflow, raw.workflowId, executions, details, now);

  console.log(`\n${exp.fixture}: ${analysis.findings.length} findings, ${analysis.receipts.length} receipts`);

  for (const want of exp.mustFind) {
    const hit = analysis.findings.find(
      (f) =>
        f.rule === want.rule &&
        (want.severity === undefined || f.severity === want.severity) &&
        (want.executionId === undefined || f.execution_id === want.executionId),
    );
    if (!hit) fail(`expected finding ${want.rule}${want.severity ? `/${want.severity}` : ""}${want.executionId ? ` on execution ${want.executionId}` : ""}`);
  }
  for (const banned of exp.mustNotFind ?? []) {
    if (analysis.findings.some((f) => f.rule === banned.rule)) {
      fail(`unexpected finding ${banned.rule}`);
    }
  }
  if (exp.receiptCount !== undefined && analysis.receipts.length !== exp.receiptCount) {
    fail(`expected ${exp.receiptCount} receipts, got ${analysis.receipts.length}`);
  }
  for (const [execId, verdict] of Object.entries(exp.receiptVerdicts ?? {})) {
    const receipt = analysis.receipts.find((r) => r.execution_id === execId);
    if (!receipt) {
      fail(`missing receipt for execution ${execId}`);
      continue;
    }
    if (receipt.verdict !== verdict) {
      fail(`receipt ${execId}: expected verdict ${verdict}, got ${receipt.verdict}`);
    }
  }
  // Every receipt must validate against its own published schema.
  for (const r of analysis.receipts) {
    const parsed = ReceiptSchema.safeParse(r);
    if (!parsed.success) fail(`receipt ${r.execution_id} failed schema validation: ${parsed.error.message}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} execution-audit assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll execution-audit fixtures passed.");
