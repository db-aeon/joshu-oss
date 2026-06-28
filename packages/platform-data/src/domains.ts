import { jsonFetch, resolveApiBase } from "./http.js";
import { resolveMailMirrorPath, resolveMailSearchPath, resolveMailSyncPath } from "./tierRouter.js";
import type {
  ConnectorsStatus,
  DataTier,
  MailProvider,
  MailSearchHit,
  PlatformDataClientOptions,
} from "./types.js";

export function createConnectionsApi(opts: PlatformDataClientOptions) {
  const apiBase = resolveApiBase(opts.apiBase);
  const fetchFn = opts.fetch ?? fetch;

  return {
    async status(): Promise<ConnectorsStatus> {
      return jsonFetch(fetchFn, `${apiBase}/connectors/status`, { cache: "no-store" });
    },
  };
}

export function createMailApi(opts: PlatformDataClientOptions) {
  const apiBase = resolveApiBase(opts.apiBase);
  const fetchFn = opts.fetch ?? fetch;

  return {
    async search(params: {
      q?: string;
      provider: MailProvider;
      tier?: DataTier;
      limit?: number;
      connectedAccountId?: string;
    }): Promise<{ hits: MailSearchHit[] }> {
      const tier = params.tier ?? "cache";
      const qs = new URLSearchParams();
      if (params.q?.trim()) qs.set("q", params.q.trim());
      if (params.limit) qs.set("limit", String(params.limit));
      if (params.connectedAccountId) qs.set("connectedAccountId", params.connectedAccountId);
      const url = resolveMailSearchPath(apiBase, params.provider, qs, tier);
      return jsonFetch(fetchFn, url, { cache: "no-store" });
    },

    async sync(params: {
      provider: MailProvider;
      connectedAccountId?: string;
      limit?: number;
      days?: number;
      ifEmpty?: boolean;
    }): Promise<{ ok?: boolean; skipped?: boolean; threadsWritten?: number; error?: string }> {
      const body: Record<string, unknown> = {
        limit: params.limit ?? 100,
        days: params.days ?? 7,
      };
      if (params.ifEmpty) body.ifEmpty = true;
      if (params.connectedAccountId) body.connectedAccountId = params.connectedAccountId;
      return jsonFetch(fetchFn, resolveMailSyncPath(apiBase, params.provider), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },

    async mirror(params: { provider: MailProvider }): Promise<{ empty?: boolean; threadCount?: number }> {
      return jsonFetch(fetchFn, resolveMailMirrorPath(apiBase, params.provider), { cache: "no-store" });
    },

    async getGmailMessage(messageId: string, connectedAccountId: string): Promise<unknown> {
      const qs = new URLSearchParams({ connectedAccountId });
      return jsonFetch(
        fetchFn,
        `${apiBase}/connectors/mail/gmail/messages/${encodeURIComponent(messageId)}?${qs}`,
        { cache: "no-store" },
      );
    },

    async sendGmail(body: Record<string, unknown>): Promise<unknown> {
      return jsonFetch(fetchFn, `${apiBase}/connectors/mail/gmail/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },

    async replyGmail(body: Record<string, unknown>): Promise<unknown> {
      return jsonFetch(fetchFn, `${apiBase}/connectors/mail/gmail/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  };
}

export function createNylasApi(opts: PlatformDataClientOptions) {
  const apiBase = resolveApiBase(opts.apiBase);
  const root = opts.apiBase?.includes("/nylas") ? apiBase : `${apiBase}/nylas`;
  const fetchFn = opts.fetch ?? fetch;

  return {
    async status(): Promise<import("./types.js").NylasStatus> {
      return jsonFetch(fetchFn, `${root}/status`);
    },
    async getProfile(): Promise<{ profile?: Record<string, unknown> }> {
      return jsonFetch(fetchFn, `${root}/profile`, { cache: "no-store" });
    },
    async saveProfile(profile: Record<string, unknown>): Promise<unknown> {
      return jsonFetch(fetchFn, `${root}/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
    },
    async listMessages(limit = 40): Promise<{ messages?: unknown[] }> {
      const qs = new URLSearchParams({ limit: String(limit) });
      return jsonFetch(fetchFn, `${root}/messages?${qs}`);
    },
    async getMessage(messageId: string): Promise<unknown> {
      return jsonFetch(fetchFn, `${root}/messages/${encodeURIComponent(messageId)}`);
    },
    async patchMessage(messageId: string, patch: Record<string, unknown>): Promise<unknown> {
      return jsonFetch(fetchFn, `${root}/messages/${encodeURIComponent(messageId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    },
    async sendMessage(body: Record<string, unknown>, headers?: Record<string, string>): Promise<unknown> {
      return jsonFetch(fetchFn, `${root}/messages/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    },
    async provisionAgent(email: string): Promise<unknown> {
      return jsonFetch(fetchFn, `${root}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    },
    async testSend(to: string): Promise<unknown> {
      return jsonFetch(fetchFn, `${root}/test-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
    },
  };
}
