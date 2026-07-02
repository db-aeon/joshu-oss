import { useEffect, useMemo, useState } from "react";

import { resolvePortraitUrl } from "@joshu/jchat-ui";

export type JoshuCompanionIdentity = {
  name: string;
  imageUrl: string | null;
  avatarUrl: string | null;
  ownerDisplayName: string;
  portraitUrl: string;
};

const IDENTITY_API = "/joshu/api/instance/identity";

/** Load companion persona for Chat Heads and message avatars. */
export function useJoshuCompanionIdentity(apiBase = "/joshu/api"): JoshuCompanionIdentity {
  const identityUrl = `${apiBase.replace(/\/+$/, "")}/instance/identity`;

  const [identity, setIdentity] = useState<Omit<JoshuCompanionIdentity, "portraitUrl">>({
    name: "Assistant",
    imageUrl: null,
    avatarUrl: null,
    ownerDisplayName: "You",
  });

  useEffect(() => {
    let cancelled = false;
    fetch(identityUrl, { cache: "no-store" })
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
          name: json.name?.trim() || "Assistant",
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
  }, [identityUrl]);

  const portraitUrl = useMemo(
    () => resolvePortraitUrl(identity.imageUrl, identity.avatarUrl),
    [identity.avatarUrl, identity.imageUrl],
  );

  return { ...identity, portraitUrl };
}
