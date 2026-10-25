/**
 * Slack Web API calls for Slack chat setup (Slack connect and the manual path).
 *
 * Each function takes its token as an argument. No function logs a token or
 * puts a token into an error message: errors carry only the method name and
 * the Slack error code.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const SLACK_API_BASE = "https://slack.com/api";
const SLACK_TIMEOUT_MS = 15_000;

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    detail?: string,
  ) {
    super(detail ? `${method}: ${code} (${detail})` : `${method}: ${code}`);
    this.name = "SlackApiError";
  }
}

type SlackResponse = { ok?: boolean; error?: string } & Record<string, unknown>;

async function callSlack(
  method: string,
  params: Record<string, string>,
  opts: { token?: string; fetchImpl?: FetchLike } = {},
): Promise<SlackResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await fetchImpl(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers,
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SlackApiError(method, "request_failed", (err as Error).message);
  }
  const json = (await res.json().catch(() => ({}))) as SlackResponse;
  if (!json.ok) {
    throw new SlackApiError(method, json.error || `http_${res.status}`, manifestErrorDetail(json));
  }
  return json;
}

/** `invalid_manifest` lists each schema error with a pointer. The list has no secret. */
function manifestErrorDetail(json: SlackResponse): string | undefined {
  const errors = json.errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  return errors
    .slice(0, 5)
    .map((e) => {
      const row = (e ?? {}) as { message?: unknown; pointer?: unknown };
      return `${String(row.pointer ?? "")} ${String(row.message ?? "")}`.trim();
    })
    .join("; ");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export type SlackBotIdentity = { team: string; teamId: string; botUserId: string; botId: string; url: string };

/** Check a bot token (`xoxb-`). */
export async function slackAuthTest(botToken: string, fetchImpl?: FetchLike): Promise<SlackBotIdentity> {
  const json = await callSlack("auth.test", {}, { token: botToken, fetchImpl });
  return {
    team: str(json.team),
    teamId: str(json.team_id),
    botUserId: str(json.user_id),
    botId: str(json.bot_id),
    url: str(json.url),
  };
}

/**
 * Check an app token (`xapp-`). Slack answers with a Socket Mode URL; the
 * caller does not connect to it.
 */
export async function slackAppsConnectionsOpen(appToken: string, fetchImpl?: FetchLike): Promise<void> {
  await callSlack("apps.connections.open", {}, { token: appToken, fetchImpl });
}

export type SlackCreatedApp = {
  appId: string;
  clientId: string;
  clientSecret: string;
  oauthAuthorizeUrl: string;
};

/** Make a Slack app from a manifest. Needs a configuration token. */
export async function slackAppsManifestCreate(
  configurationToken: string,
  manifest: unknown,
  fetchImpl?: FetchLike,
): Promise<SlackCreatedApp> {
  const json = await callSlack(
    "apps.manifest.create",
    { manifest: JSON.stringify(manifest) },
    { token: configurationToken, fetchImpl },
  );
  const credentials = (json.credentials ?? {}) as Record<string, unknown>;
  return {
    appId: str(json.app_id),
    clientId: str(credentials.client_id),
    clientSecret: str(credentials.client_secret),
    oauthAuthorizeUrl: str(json.oauth_authorize_url),
  };
}

/** Delete a Slack app. Needs a configuration token of the same workspace. */
export async function slackAppsManifestDelete(
  configurationToken: string,
  appId: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  await callSlack("apps.manifest.delete", { app_id: appId }, { token: configurationToken, fetchImpl });
}

export type SlackOAuthResult = {
  botToken: string;
  botUserId: string;
  appId: string;
  teamId: string;
  teamName: string;
  /** The Slack user who clicked Allow. */
  authedUserId: string;
};

/** Exchange the OAuth code from the redirect for the bot token. */
export async function slackOAuthV2Access(
  args: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  fetchImpl?: FetchLike,
): Promise<SlackOAuthResult> {
  const json = await callSlack(
    "oauth.v2.access",
    {
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
    },
    { fetchImpl },
  );
  const team = (json.team ?? {}) as Record<string, unknown>;
  const authedUser = (json.authed_user ?? {}) as Record<string, unknown>;
  return {
    botToken: str(json.access_token),
    botUserId: str(json.bot_user_id),
    appId: str(json.app_id),
    teamId: str(team.id),
    teamName: str(team.name),
    authedUserId: str(authedUser.id),
  };
}

/** Slack user ID for an email address, or null when no user has the address. */
export async function slackUsersLookupByEmail(
  botToken: string,
  email: string,
  fetchImpl?: FetchLike,
): Promise<string | null> {
  try {
    const json = await callSlack("users.lookupByEmail", { email }, { token: botToken, fetchImpl });
    const user = (json.user ?? {}) as Record<string, unknown>;
    return str(user.id) || null;
  } catch (err) {
    if (err instanceof SlackApiError && err.code === "users_not_found") return null;
    throw err;
  }
}

/** Open (or find) the DM channel between the bot and one user. */
export async function slackConversationsOpen(
  botToken: string,
  userId: string,
  fetchImpl?: FetchLike,
): Promise<string> {
  const json = await callSlack("conversations.open", { users: userId }, { token: botToken, fetchImpl });
  const channel = (json.channel ?? {}) as Record<string, unknown>;
  return str(channel.id);
}

export async function slackChatPostMessage(
  botToken: string,
  channel: string,
  text: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  await callSlack("chat.postMessage", { channel, text }, { token: botToken, fetchImpl });
}
