import { Composio } from "@composio/core";
import { COMPOSIO_GMAIL_TOOLKIT_SLUG, COMPOSIO_GMAIL_TOOLKIT_VERSION } from "./gmailConfig.js";

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
      },
    });
  }
  return cached;
}
