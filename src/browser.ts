// Browser entrypoint for the FlowVault audit core.
//
// Bundled with esbuild (iife) and served on flowvault.se/audit. The exact same
// deterministic rule set as the MCP runs client-side: the pasted workflow JSON
// never leaves the visitor's browser. No backend, no rate limit, no telemetry.

import { audit, RULES_RUN } from "./audit.js";

declare global {
  // eslint-disable-next-line no-var
  var FlowVaultAudit: { audit: typeof audit; rulesRun: typeof RULES_RUN; version: string };
}

globalThis.FlowVaultAudit = {
  audit,
  rulesRun: RULES_RUN,
  version: "0.4.0",
};
