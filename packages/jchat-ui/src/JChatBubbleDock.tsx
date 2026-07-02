import React, { type ReactNode } from "react";

import { JChatAvatar } from "./JChatAvatar.js";

export type JChatBubbleVoiceControl = {
  available: boolean;
  active: boolean;
  onToggle: () => void;
  title?: string;
};

export type JChatBubbleDockProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companionName: string;
  companionAvatarUrl: string;
  voice?: JChatBubbleVoiceControl;
  position?: "left" | "right";
  panelWidth?: number | string;
  ariaLabel?: string;
  /** Unread / activity pulse on the head. */
  hasActivity?: boolean;
  children: ReactNode;
};

/**
 * Messenger-style Chat Head: persistent avatar FAB toggles the floating panel.
 * Mic badge on the head toggles voice without opening/closing chat.
 */
export function JChatBubbleDock({
  open,
  onOpenChange,
  companionName,
  companionAvatarUrl,
  voice,
  position = "right",
  panelWidth = 360,
  ariaLabel,
  hasActivity = false,
  children,
}: JChatBubbleDockProps): React.ReactElement {
  const widthStyle =
    typeof panelWidth === "number" ? { width: `${panelWidth}px` } : { width: panelWidth };

  const voiceTitle =
    voice?.title ??
    (voice?.active ? "Turn voice off" : voice?.available ? "Turn voice on" : "Voice unavailable");

  return (
    <div
      className={`jchat-bubble-dock jchat-bubble-dock--${position} ${open ? "jchat-bubble-dock--open" : ""}`}
      data-voice-active={voice?.active ? "true" : "false"}
    >
      {open ? (
        <div className="jchat-bubble-panel" style={widthStyle} role="dialog" aria-label={ariaLabel ?? companionName}>
          {children}
        </div>
      ) : null}

      <div className="jchat-bubble-head-wrap">
        <button
          type="button"
          className={`jchat-bubble-head ${open ? "jchat-bubble-head--open" : ""} ${hasActivity ? "jchat-bubble-head--activity" : ""}`}
          aria-expanded={open}
          aria-label={open ? `Hide chat with ${companionName}` : `Open chat with ${companionName}`}
          onClick={() => onOpenChange(!open)}
        >
          <JChatAvatar src={companionAvatarUrl} label={companionName} size="head" />
          <span className="jchat-bubble-head-ring" aria-hidden />
        </button>

        {voice ? (
          <button
            type="button"
            className={`jchat-bubble-mic ${voice.active ? "jchat-bubble-mic--on" : ""}`}
            aria-pressed={voice.active}
            aria-label={voiceTitle}
            disabled={!voice.available}
            title={voiceTitle}
            onClick={(event) => {
              event.stopPropagation();
              if (voice.available) voice.onToggle();
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden focusable="false">
              <path
                fill="currentColor"
                d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V19H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-1.08A7 7 0 0 0 17 11z"
              />
            </svg>
          </button>
        ) : null}
      </div>
    </div>
  );
}
