import { composioCallBlockReason } from "../../mcpToolPolicy.js";
import { isActionGuarded, loadActionGuardPolicy } from "../../actionGuard/policy.js";
import { awaitOwnerApproval, buildComposioToolSummary } from "../../actionGuard/gate.js";

const OWNER_CHANNEL_DENIED_PREFIX = "Owner denied or timed out";

export class McpToolPolicyBlockedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "McpToolPolicyBlockedError";
    this.reason = reason;
  }
}

export class OwnerChannelDeniedError extends Error {
  readonly toolSlug: string;
  constructor(toolSlug: string) {
    super(`${OWNER_CHANNEL_DENIED_PREFIX}: ${toolSlug}`);
    this.name = "OwnerChannelDeniedError";
    this.toolSlug = toolSlug;
  }
}

/** True when an error message comes from OwnerChannelDeniedError (also after a wrapper rethrows it). */
export function isOwnerChannelDeniedMessage(message: string | undefined): boolean {
  return Boolean(message?.includes(OWNER_CHANNEL_DENIED_PREFIX));
}

type BeforeExecuteParams = {
  userId: string;
  connectedAccountId?: string;
  arguments: Record<string, unknown>;
};

type BeforeExecuteContext = {
  toolSlug: string;
  toolkitSlug?: string;
  params: BeforeExecuteParams;
};

function shouldGateComposioTool(toolSlug: string, projectRoot: string): boolean {
  const policy = loadActionGuardPolicy(projectRoot);
  if (!policy.enabled) return false;
  return isActionGuarded(`composio:${toolSlug.trim()}`, projectRoot);
}

export function createOwnerChannelBeforeExecute(projectRoot = process.cwd()) {
  return async ({ toolSlug, params }: BeforeExecuteContext): Promise<BeforeExecuteParams> => {
    const hardBlock = composioCallBlockReason(toolSlug, params.arguments);
    if (hardBlock) throw new McpToolPolicyBlockedError(hardBlock);

    if (!shouldGateComposioTool(toolSlug, projectRoot)) return params;

    const result = await awaitOwnerApproval(
      {
        actionId: `composio:${toolSlug.trim()}`,
        summary: buildComposioToolSummary(toolSlug, params.arguments ?? {}),
      },
      projectRoot,
    );

    if (result.decision === "denied" || result.decision === "timeout") {
      throw new OwnerChannelDeniedError(toolSlug);
    }
    if (result.decision === "unavailable") {
      throw new Error(result.unavailableReason ?? "Owner channel unavailable");
    }
    return params;
  };
}
