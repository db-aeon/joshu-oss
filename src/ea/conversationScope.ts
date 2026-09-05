/**
 * EA-facing re-exports — mail coordination scope (phase 1).
 * Future SMS/Slack ingress imports from ../coordination/index.js directly.
 */
export {
  assertSpawnAllowed,
  mergeScopes,
  registerCoordination,
  resolveCoordinationScope,
  resolveMailCoordinationScope,
  listActiveCoordinationForScope,
  taskBodyMatchesScope,
  findOpenMeetingByScope,
  findOpenOwnerReplyByScope,
} from "../coordination/index.js";
export type {
  ActiveCoordination,
  CoordinationScope,
  MailScopeInput,
  SpawnAllowedResult,
} from "../coordination/index.js";
