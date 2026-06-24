// Shared types for audit findings and reports.

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type RuleId =
  | "R1.error-coverage"
  | "R2.suppression-check"
  | "R3.auth-drift"
  | "R8.webhook-respond-shape"
  | "R9.hardcoded-recipients"
  | "R10.dead-end-branches"
  | "R11.post-send-observability";

export interface Finding {
  rule: RuleId;
  severity: Severity;
  node_id: string | null;
  node_name: string | null;
  message: string;
  fix_hint: string;
}

export type Grade = "production-ready" | "conditional" | "not-ready";

export interface SeveritySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  total: number;
}

export interface AuditReport {
  generated_at: string;
  workflow_name: string;
  workflow_node_count: number;
  grade: Grade;
  grade_emoji: "🟢" | "🟡" | "🔴";
  summary: SeveritySummary;
  findings: Finding[];
  rules_run: RuleId[];
  notes: string[];
}

export interface AuditError {
  error: string;
  detail?: string;
}

export type AuditResult =
  | { ok: true; report: AuditReport }
  | { ok: false; error: AuditError };
