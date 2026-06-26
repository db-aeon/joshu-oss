#!/usr/bin/env node
/**
 * @deprecated Use `npm run hermes:sync-skills-policy` (allowlist-driven).
 * Legacy: copy skills.disabled from ~/.hermes/config.yaml into the repo file.
 */
console.warn("[hermes] hermes:export-skills-disabled is deprecated; run: npm run hermes:sync-skills-policy");
await import("./sync-hermes-skills-policy.mjs");
