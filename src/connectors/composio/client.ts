import { Composio } from "@composio/core";
import { COMPOSIO_GMAIL_TOOLKIT_SLUG, COMPOSIO_GMAIL_TOOLKIT_VERSION } from "./gmailConfig.js";
import {
  COMPOSIO_GOOGLECALENDAR_TOOLKIT_SLUG,
  COMPOSIO_GOOGLECALENDAR_TOOLKIT_VERSION,
} from "./googleCalendarConfig.js";
import { COMPOSIO_SLACKBOT_TOOLKIT_SLUG, COMPOSIO_SLACKBOT_TOOLKIT_VERSION } from "./slackbotConfig.js";

function envTrim(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

let cached: Composio | null = null;

export function composioClient(): Composio {
  const apiKey = envTrim("COMPOSIO_API_KEY");
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set");
  if (!cached) {
    cached = new Composio({
      apiKey,
      toolkitVersions: {
        [COMPOSIO_GMAIL_TOOLKIT_SLUG]: COMPOSIO_GMAIL_TOOLKIT_VERSION,
        [COMPOSIO_GOOGLECALENDAR_TOOLKIT_SLUG]: COMPOSIO_GOOGLECALENDAR_TOOLKIT_VERSION,
        [COMPOSIO_SLACKBOT_TOOLKIT_SLUG]: COMPOSIO_SLACKBOT_TOOLKIT_VERSION,
      },
    });
  }
  return cached;
}

/** Tests only: put a stub in place of the cached client (null clears it). */
export function setComposioClientForTest(client: Composio | null): void {
  cached = client;
}
