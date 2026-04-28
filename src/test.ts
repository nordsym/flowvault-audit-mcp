#!/usr/bin/env node
// FlowVault Audit MCP smoke test matrix.
//
// Runs every fixture in fixtures/ through audit() and asserts the expected
// findings shape per fixture. This is the deterministic gate the .mcpb bundle
// must pass before shipping.
//
// Usage: npm test

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { audit } from "./audit.js";
import type { Finding, Grade, RuleId, Severity } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "../fixtures");

interface Expectation {
  fixture: string;
  description: string;
  expectedGrade: Grade;
  // Each entry asserts that at least one finding matches all listed predicates.
  mustFind: Array<{
    rule: RuleId;
    severity?: Severity;
    nodeName?: string;
    messageIncludes?: string;
  }>;
  // Each entry asserts NO finding matches.
  mustNotFind?: Array<{
    rule: RuleId;
    severity?: Severity;
    nodeName?: string;
  }>;
}

const EXPECTATIONS: Expectation[] = [
  {
    fixture: "bortforsla-send-buggy.json",
    description:
      "Bortforsla case study: inverted IF gate, legacy creds, no error coverage. Must grade NOT-READY and surface all three rules.",
    expectedGrade: "not-ready",
    mustFind: [
      {
        rule: "R2.suppression-check",
        severity: "high",
        nodeName: "Gmail Send Outreach",
        messageIncludes: "Inverted wiring",
      },
      {
        rule: "R3.auth-drift",
        severity: "high",
        messageIncludes: "drift marker",
      },
      {
        rule: "R1.error-coverage",
        nodeName: "Gmail Send Outreach",
      },
    ],
  },
  {
    fixture: "bortforsla-send-fixed.json",
    description:
      "Same workflow, properly wired. Suppression gate non-inverted, error branches present, creds carry rotation tags. Should grade PRODUCTION-READY.",
    expectedGrade: "production-ready",
    mustFind: [],
    mustNotFind: [
      { rule: "R2.suppression-check" },
      { rule: "R1.error-coverage", severity: "high" },
      { rule: "R3.auth-drift", severity: "high" },
    ],
  },
  {
    fixture: "outbound-no-gate.json",
    description:
      "Cold-blast Gmail send with no upstream gate. R2 must fire CRITICAL.",
    expectedGrade: "not-ready",
    mustFind: [
      {
        rule: "R2.suppression-check",
        severity: "critical",
        nodeName: "Gmail Send",
        messageIncludes: "no IF/Switch/Filter gate upstream",
      },
    ],
  },
  {
    fixture: "twilio-sms-no-suppression.json",
    description:
      "Twilio SMS reminder with no suppression check. R2 critical fires beyond email surfaces.",
    expectedGrade: "not-ready",
    mustFind: [
      {
        rule: "R2.suppression-check",
        severity: "critical",
        nodeName: "Twilio Send SMS",
      },
    ],
  },
  {
    fixture: "slack-broadcast-filter-clean.json",
    description:
      "Customer-broadcast Slack post gated by Filter node with 'unsubscribed' keyword. Should pass R2 cleanly.",
    expectedGrade: "production-ready",
    mustFind: [],
    mustNotFind: [{ rule: "R2.suppression-check" }],
  },
  {
    fixture: "webhook-respond-clean.json",
    description:
      "Webhook + Postgres + respond-to-webhook. No outbound send. R2 should not fire at all.",
    expectedGrade: "production-ready",
    mustFind: [],
    mustNotFind: [{ rule: "R2.suppression-check" }],
  },
  {
    fixture: "stripe-charge-missing-errors.json",
    description:
      "Stripe charge + receipt email with legacy test cred and no error coverage. Must surface multiple R1 highs and an R3 high.",
    expectedGrade: "not-ready",
    mustFind: [
      { rule: "R1.error-coverage", nodeName: "Stripe Create Charge" },
      { rule: "R3.auth-drift", severity: "high", messageIncludes: "drift marker" },
      { rule: "R2.suppression-check", nodeName: "Send Receipt Email" },
    ],
  },
  {
    fixture: "switch-node-suppression.json",
    description:
      "Switch with three branches; suppression keyword in conditions; send is on the third (active) branch. R2 should pass.",
    expectedGrade: "production-ready",
    mustFind: [],
    mustNotFind: [{ rule: "R2.suppression-check" }],
  },
  {
    fixture: "disabled-node-skip.json",
    description:
      "Disabled Gmail send with bad shape. Audit must skip disabled nodes; report should be clean.",
    expectedGrade: "production-ready",
    mustFind: [],
    mustNotFind: [
      { rule: "R1.error-coverage", nodeName: "Disabled Gmail Send" },
      { rule: "R2.suppression-check", nodeName: "Disabled Gmail Send" },
      { rule: "R3.auth-drift", nodeName: "Disabled Gmail Send" },
    ],
  },
  {
    fixture: "langchain-agent-stale-creds.json",
    description:
      "Langchain agent flow with stale 'tmp' OpenAI cred. R3 must fire high on the OpenAI node. Single-high grade is conditional.",
    expectedGrade: "conditional",
    mustFind: [
      {
        rule: "R3.auth-drift",
        severity: "high",
        nodeName: "OpenAI Chat",
        messageIncludes: "drift marker",
      },
    ],
  },
  {
    fixture: "credential-id-name-drift.json",
    description:
      "Same credential id referenced under two different names. R3 medium fires.",
    expectedGrade: "conditional",
    mustFind: [
      {
        rule: "R3.auth-drift",
        severity: "medium",
        messageIncludes: "conflicting display names",
      },
    ],
  },
  {
    fixture: "editor-export-envelope.json",
    description:
      "Validates parser unwrap for {workflowData: ...} editor exports.",
    expectedGrade: "production-ready",
    mustFind: [],
  },
];

function findingMatches(
  finding: Finding,
  q: { rule: RuleId; severity?: Severity; nodeName?: string; messageIncludes?: string },
): boolean {
  if (finding.rule !== q.rule) return false;
  if (q.severity && finding.severity !== q.severity) return false;
  if (q.nodeName && finding.node_name !== q.nodeName) return false;
  if (q.messageIncludes && !finding.message.toLowerCase().includes(q.messageIncludes.toLowerCase())) return false;
  return true;
}

interface CaseResult {
  fixture: string;
  passed: boolean;
  failures: string[];
  totalFindings: number;
  grade: Grade | "error";
}

function runCase(exp: Expectation): CaseResult {
  const path = join(FIXTURES_DIR, exp.fixture);
  const json = readFileSync(path, "utf8");
  const result = audit(json);
  const failures: string[] = [];

  if (!result.ok) {
    return {
      fixture: exp.fixture,
      passed: false,
      failures: [`audit error: ${result.error.error} ${result.error.detail ?? ""}`],
      totalFindings: 0,
      grade: "error",
    };
  }

  const { report } = result;

  if (report.grade !== exp.expectedGrade) {
    failures.push(
      `expected grade ${exp.expectedGrade}, got ${report.grade} (${report.grade_emoji})`,
    );
  }

  for (const want of exp.mustFind) {
    const hit = report.findings.find((f) => findingMatches(f, want));
    if (!hit) {
      failures.push(`mustFind not satisfied: ${JSON.stringify(want)}`);
    }
  }

  for (const want of exp.mustNotFind ?? []) {
    const hit = report.findings.find((f) => findingMatches(f, want));
    if (hit) {
      failures.push(
        `mustNotFind violated: ${JSON.stringify(want)} - matched finding ${JSON.stringify({ rule: hit.rule, severity: hit.severity, node_name: hit.node_name })}`,
      );
    }
  }

  return {
    fixture: exp.fixture,
    passed: failures.length === 0,
    failures,
    totalFindings: report.findings.length,
    grade: report.grade,
  };
}

function main() {
  // Sanity: every fixture file is covered by an expectation.
  const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  const covered = new Set(EXPECTATIONS.map((e) => e.fixture));
  const orphans = fixtureFiles.filter((f) => !covered.has(f));
  if (orphans.length > 0) {
    console.error(`[test] orphan fixtures with no expectation: ${orphans.join(", ")}`);
  }

  const results = EXPECTATIONS.map(runCase);
  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  console.log("\nFlowVault Audit MCP - test matrix\n");
  console.log("fixture                                          grade           findings   status");
  console.log("------------------------------------------------ --------------- ---------- ------");
  for (const r of results) {
    const fx = r.fixture.padEnd(48);
    const grade = String(r.grade).padEnd(15);
    const findings = String(r.totalFindings).padStart(3).padEnd(10);
    const status = r.passed ? "PASS" : "FAIL";
    console.log(`${fx} ${grade} ${findings} ${status}`);
  }
  console.log("");
  for (const r of failed) {
    console.log(`FAIL ${r.fixture}`);
    for (const f of r.failures) console.log(`  - ${f}`);
  }
  console.log(
    `\n${passed.length}/${results.length} passed. ${orphans.length} orphan(s).\n`,
  );

  if (failed.length > 0 || orphans.length > 0) process.exit(1);
}

main();
