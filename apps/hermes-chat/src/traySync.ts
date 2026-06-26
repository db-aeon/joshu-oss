/** Notify ArozOS shell overlay (aroz-jchat-tray.js) about persona + gateway notifications. */
export type JChatTrayPayload = {
  assistantName: string;
  portraitUrl: string;
  /** Set only when the gateway delivers a new assistant message to show as a tray toast. */
  notification?: string | null;
  voiceInputOn?: boolean;
  voiceAvailable?: boolean;
  /** Normalized audio level 0–1 for the Winamp-style meter. */
  audioLevel?: number;
};

export function syncJChatTray(payload: JChatTrayPayload): void {
  try {
    const portraitUrl = payload.portraitUrl.startsWith("http")
      ? payload.portraitUrl
      : new URL(payload.portraitUrl, window.location.href).href;
    window.parent.postMessage({ type: "jchat:tray", ...payload, portraitUrl }, "*");
  } catch {
    /* cross-origin or standalone dev */
  }
}
