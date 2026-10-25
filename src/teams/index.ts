/** Production wiring of Multiplayer teams on this box. */
import { callCronBridge } from "../hermesCronBridge.js";
import { callKanbanBridge } from "../hermesKanbanBridge.js";
import { resolveJoshuAvatarUrl, resolveJoshuIdentity } from "../joshuIdentity.js";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import { syncHermesOwnerTimezone } from "../hermesOwnerTimezone.js";
import { getOwnerTimeAnchor, resolveOwnerTimezone } from "../ownerLocalTime.js";
import { sendOwnerText } from "../ownerTextChannel.js";
import { proactiveResolveSessionKey, resolveProactiveOwnerReply } from "../proactive/resolveOwnerReply.js";
import { ownerLocalDateString, readProactiveState, recordOwnerQuestionText, writeProactiveState } from "../proactive/state.js";
import { fetchCompanionAvatar } from "./avatar.js";
import { boxPublicBaseUrl, MembershipStore, teamsDir, type FetchLike } from "./membership.js";
import { TeamRoomStore } from "./roomStore.js";
import { TeamService } from "./service.js";

let store: TeamRoomStore | undefined;
let service: TeamService | undefined;

export function teamRoomStore(projectRoot: string): TeamRoomStore {
  store ??= new TeamRoomStore(teamsDir(projectRoot));
  return store;
}

export function teamService(
  projectRoot: string,
  hooks: { standupModel: () => string; onTeamsChanged: () => Promise<void> },
): TeamService {
  service ??= new TeamService({
    projectRoot,
    store: teamRoomStore(projectRoot),
    memberships: new MembershipStore(teamsDir(projectRoot)),
    filesRoot: resolveJoshuFilesPaths(projectRoot)?.filesRoot,
    fetch: fetch as unknown as FetchLike,
    publicBaseUrl: boxPublicBaseUrl,
    profile: async () => {
      const identity = resolveJoshuIdentity(projectRoot);
      const avatar = await fetchCompanionAvatar(resolveJoshuAvatarUrl(identity));
      return { ownerName: identity.owner.displayName, companionName: identity.name, ...(avatar ? { avatar } : {}) };
    },
    sendText: (input) => sendOwnerText(projectRoot, input),
    cron: callCronBridge,
    kanban: callKanbanBridge,
    standupModel: hooks.standupModel,
    onTeamsChanged: hooks.onTeamsChanged,
    ownerToday: () => ownerLocalDateString(resolveOwnerTimezone(projectRoot)),
    ownerClock: () => {
      const anchor = getOwnerTimeAnchor(projectRoot);
      return { date: anchor.localDate, hour: Number.parseInt(anchor.localTime.slice(0, 2), 10), weekday: anchor.weekday };
    },
    ensureOwnerTimezone: async () => {
      const out = await syncHermesOwnerTimezone(resolveOwnerTimezone(projectRoot));
      if (!out.ok) console.warn(`[teams] Hermes time zone sync failed: ${out.error}`);
    },
    recordOwnerQuestion: (nudge) => writeProactiveState(recordOwnerQuestionText(readProactiveState(projectRoot), nudge), projectRoot),
    resolveOwnerReply: ({ taskId, board, body }) =>
      resolveProactiveOwnerReply({
        body,
        filesRoot: resolveJoshuFilesPaths(projectRoot)?.filesRoot ?? projectRoot,
        projectRoot,
        sessionKey: proactiveResolveSessionKey(taskId),
        taskId,
        board,
      }),
    now: () => new Date(),
  });
  return service;
}
