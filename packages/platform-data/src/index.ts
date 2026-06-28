import {
  createCalendarApi,
  createFilesApi,
  createIdentityApi,
  createMemoryApi,
} from "./platformApis.js";
import { createConnectionsApi, createMailApi, createNylasApi } from "./domains.js";
import type { PlatformDataClientOptions } from "./types.js";

export type JoshuPlatformData = ReturnType<typeof createJoshuPlatformData>;

/** Create a platform data client (browser or Node). */
export function createJoshuPlatformData(opts: PlatformDataClientOptions = {}) {
  return {
    connections: createConnectionsApi(opts),
    mail: createMailApi(opts),
    nylas: createNylasApi(opts),
    calendar: createCalendarApi(opts),
    files: createFilesApi(opts),
    memory: createMemoryApi(opts),
    identity: createIdentityApi(opts),
  };
}

export { PlatformDataError, resolveApiBase } from "./http.js";
export { resolveMailSearchPath, resolveMailSyncPath, resolveMailMirrorPath } from "./tierRouter.js";
export type * from "./types.js";
