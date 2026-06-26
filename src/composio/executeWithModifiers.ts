import { composioClient } from "../connectors/composio/client.js";
import { getOrCreateComposioSession, resolveComposioUserId } from "../composioApi.js";
import { createOwnerChannelBeforeExecute } from "./modifiers/ownerChannelBeforeExecute.js";

export type ComposioExecuteParams = {
  userId: string;
  connectedAccountId?: string;
  arguments: Record<string, unknown>;
  version?: string;
  dangerouslySkipVersionCheck?: boolean;
};

type ExecuteResult = { successful?: boolean; data?: unknown; error?: string };

export async function composioToolsExecute(
  toolSlug: string,
  params: ComposioExecuteParams,
  projectRoot = process.cwd(),
): Promise<ExecuteResult> {
  await getOrCreateComposioSession(projectRoot);
  const beforeExecute = createOwnerChannelBeforeExecute(projectRoot);
  const composio = composioClient();
  const tools = composio.tools as {
    execute: (
      slug: string,
      executeParams: ComposioExecuteParams,
      modifiers?: { beforeExecute?: typeof beforeExecute },
    ) => Promise<ExecuteResult>;
  };

  return tools.execute(
    toolSlug,
    { ...params, userId: params.userId || resolveComposioUserId(projectRoot) },
    { beforeExecute },
  );
}
