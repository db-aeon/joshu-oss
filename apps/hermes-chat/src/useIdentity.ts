import { useEffect, useState } from "react";

export type JoshuIdentity = {
  name: string;
  imageUrl: string | null;
  avatarUrl: string | null;
  ownerDisplayName: string;
};

const IDENTITY_API = "/joshu/api/instance/identity";
const PORTRAIT_FALLBACK = "/img/joshu/chat-portrait.jpg";

export function resolvePortraitUrl(
  imageUrl: string | null | undefined,
  avatarUrl?: string | null | undefined,
): string {
  if (avatarUrl?.trim()) return avatarUrl.trim();
  if (imageUrl?.trim()) return imageUrl.trim();
  try {
    return new URL(PORTRAIT_FALLBACK, window.location.origin).href;
  } catch {
    return "./portrait-fallback.jpg";
  }
}

export function useIdentity(): JoshuIdentity {
  const [identity, setIdentity] = useState<JoshuIdentity>({
    name: "John",
    imageUrl: null,
    avatarUrl: null,
    ownerDisplayName: "You",
  });

  useEffect(() => {
    let cancelled = false;
    fetch(IDENTITY_API, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const json = (await response.json()) as {
          name?: string;
          imageUrl?: string | null;
          avatarUrl?: string | null;
          owner?: { displayName?: string };
        };
        if (cancelled) return;
        setIdentity({
          name: json.name?.trim() || "John",
          imageUrl: json.imageUrl ?? null,
          avatarUrl: json.avatarUrl ?? null,
          ownerDisplayName: json.owner?.displayName?.trim() || "You",
        });
      })
      .catch(() => {
        /* keep defaults */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return identity;
}
