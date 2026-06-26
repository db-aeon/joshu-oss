import type { Request } from "express";
import { isMcpToolPolicyEnabled } from "../mcpToolPolicy.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Owner compose in jMail (ArozOS desktop iframe) — same header contract as Nylas send gate.
 * Hermes execute_code / curl must not bypass MCP hard blocks.
 */
export function isJmailOwnerClient(req: Request): boolean {
  if (readString(req.headers["x-joshu-mail-client"]) !== "jmail") return false;
  const site = readString(req.headers["sec-fetch-site"]);
  return site === "same-origin" || site === "same-site";
}

/** REST hard block for agent paths when MCP tool policy is enabled. */
export function agentRestWriteBlocked(req: Request): boolean {
  if (!isMcpToolPolicyEnabled()) return false;
  return !isJmailOwnerClient(req);
}
