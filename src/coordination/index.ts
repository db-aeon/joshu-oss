import type { ChannelScopeInput, CoordinationScope } from "./types.js";
import { mergeScopes } from "./scopeId.js";
import { resolveMailCoordinationScope } from "./adapters/mail.js";
import { deriveScopeId } from "./scopeId.js";
import type { CoordinationFacet } from "./types.js";

/** Delegate to the channel adapter and return a coordination scope. */
export async function resolveCoordinationScope(
  input: ChannelScopeInput,
): Promise<CoordinationScope> {
  switch (input.channel) {
    case "mail":
      return resolveMailCoordinationScope(input);
    case "sms": {
      // Phase 2 — minimal stub for merge contract tests.
      const facets: CoordinationFacet[] = input.messageSid
        ? [{ channel: "sms", key: input.messageSid }]
        : [{ channel: "sms", key: input.ownerPhone }];
      const participants = [input.ownerPhone, input.counterpartyHint]
        .filter((p): p is string => Boolean(p?.trim()))
        .map((p) => p.trim().toLowerCase());
      const scopeId = deriveScopeId({
        facets,
        participants,
        topic: input.topic ?? input.body.slice(0, 120),
      });
      return {
        scopeId,
        channel: "sms",
        facets,
        participants,
        topic: input.topic,
        threadIds: [],
        sourcePaths: [],
      };
    }
    default:
      throw new Error(`Unsupported coordination channel: ${(input as { channel: string }).channel}`);
  }
}

export { mergeScopes, deriveScopeId, normalizeTopic } from "./scopeId.js";
export {
  assertSpawnAllowed,
  resolveMailCoordinationScope,
  listActiveCoordinationForScope,
  listAllActiveCoordination,
  taskBodyMatchesScope,
  findOpenMeetingByScope,
  findOpenOwnerReplyByScope,
  activeFromKanbanTasks,
} from "./adapters/mail.js";
export { registerCoordination, unregisterCoordination } from "./registry.js";
export type {
  ActiveCoordination,
  CoordinationCapability,
  CoordinationChannel,
  CoordinationFacet,
  CoordinationScope,
  MailScopeInput,
  SmsScopeInput,
  SpawnAllowedResult,
} from "./types.js";
