import React from "react";

export type JChatAvatarProps = {
  src?: string | null;
  label: string;
  size?: "sm" | "md" | "lg" | "head";
  className?: string;
};

function initials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

/** Circular avatar — image or initials fallback (Chat Heads / Messenger style). */
export function JChatAvatar({
  src,
  label,
  size = "md",
  className = "",
}: JChatAvatarProps): React.ReactElement {
  const [broken, setBroken] = React.useState(false);
  const showImage = Boolean(src?.trim()) && !broken;

  return (
    <span
      className={`jchat-avatar jchat-avatar--${size} ${className}`.trim()}
      title={label}
      aria-hidden={showImage ? undefined : true}
    >
      {showImage ? (
        <img src={src!} alt="" onError={() => setBroken(true)} />
      ) : (
        <span className="jchat-avatar-initials" aria-label={label}>
          {initials(label)}
        </span>
      )}
    </span>
  );
}
