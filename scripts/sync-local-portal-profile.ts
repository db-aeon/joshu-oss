#!/usr/bin/env npx tsx
/**
 * Pull portal companion profile + personality quiz from control-plane Supabase
 * into local ArozOS user data (.joshu/*) and Hermes SOUL.md.
 *
 * Usage:
 *   bash scripts/sync-local-portal-profile.sh [owner-email]
 * Requires apps/control-plane/.env.local with DATABASE_URL.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "../apps/control-plane/src/generated/prisma/index.js";
import type { CompanionCandidate, OnboardingDraft } from "../apps/control-plane/src/lib/companion-forge/types.js";

function selectedCompanion(draft: OnboardingDraft | null): CompanionCandidate | null {
  if (!draft?.candidates?.length || draft.selectedCandidateIndex == null) return null;
  return draft.candidates[draft.selectedCandidateIndex] ?? null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const email = process.argv[2]?.trim() || "db@project-aeon.com";
const arozData = process.env.AROZ_DATA?.trim() || path.join(ROOT_DIR, ".local", "arozos-data");
const hermesHome = process.env.HERMES_HOME?.trim() || path.join(process.env.HOME ?? "", ".hermes");

const SOUL_MARKER = "<!-- joshu-managed: companion-soul -->";

function userJoshuDir(ownerEmail: string): string {
  return path.join(arozData, "files", "users", ownerEmail, ".joshu");
}

function writeJson(file: string, data: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode });
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const row = await prisma.portalUser.findUnique({
      where: { email },
      include: {
        customer: {
          include: { instance: { select: { id: true, status: true } } },
        },
      },
    });

    if (!row) {
      console.error(`No PortalUser for ${email}`);
      process.exit(1);
    }

    const draft = row.onboardingDraft as OnboardingDraft | null;
    const customer = row.customer;
    const metadataRaw = customer?.metadata;
    const metadata =
      metadataRaw && typeof metadataRaw === "object" && !Array.isArray(metadataRaw)
        ? (metadataRaw as Record<string, unknown>)
        : {};

    const ownerEmail =
      (typeof metadata.ownerEmail === "string" && metadata.ownerEmail.trim()) || email;

    const joshuDir = userJoshuDir(ownerEmail);
    if (!fs.existsSync(path.dirname(joshuDir))) {
      console.error(`ArozOS user dir missing: ${path.dirname(joshuDir)}`);
      process.exit(1);
    }

    const companion = draft ? selectedCompanion(draft) : null;

    const joshuDisplayName =
      (draft?.joshuName?.trim()) ||
      (typeof metadata.joshuName === "string" ? metadata.joshuName.trim() : "") ||
      customer?.name ||
      "Patrick";

    const ownerDisplayName =
      draft?.ownerFullName?.trim() ||
      (typeof metadata.ownerDisplayName === "string" ? metadata.ownerDisplayName.trim() : "") ||
      "Dan";

    const portraitUrl =
      companion?.portrait_image_url ||
      (typeof metadata.joshuImageUrl === "string" ? metadata.joshuImageUrl : null) ||
      null;

    const avatarUrl =
      companion?.avatar_image_url ||
      (typeof metadata.joshuAvatarUrl === "string" ? metadata.joshuAvatarUrl : null) ||
      null;

    const voiceId =
      companion?.voice_id?.trim() ||
      (typeof metadata.joshuVoiceId === "string" ? metadata.joshuVoiceId.trim() : "") ||
      null;

    const soulMd =
      companion?.soul_md ||
      (typeof metadata.companionSoulMd === "string" ? metadata.companionSoulMd : "") ||
      "";

    const portalProfile = {
      schemaVersion: 1,
      syncedAt: new Date().toISOString(),
      source: "control-plane",
      ownerEmail,
      portalUser: {
        id: row.id,
        email: row.email,
        shareCode: row.shareCode,
        referralTier: row.referralTier,
        inviteVerifiedAt: row.inviteVerifiedAt?.toISOString() ?? null,
        onboardingCompletedAt: row.onboardingCompletedAt?.toISOString() ?? null,
      },
      customer: customer
        ? {
            id: customer.id,
            slug: customer.slug,
            name: customer.name,
            status: customer.status,
            metadata,
            instance: customer.instance ?? null,
          }
        : null,
      onboardingDraft: draft ?? null,
      selectedCompanion: companion,
    };

    writeJson(path.join(joshuDir, "portal-profile.json"), portalProfile);

    writeJson(path.join(joshuDir, "identity.json"), {
      schemaVersion: 1,
      name: joshuDisplayName,
      imageUrl: portraitUrl,
      avatarUrl,
      voiceId,
      owner: {
        displayName: ownerDisplayName,
        email: ownerEmail,
      },
      updatedAt: new Date().toISOString(),
      source: "control-plane",
    });

    const profilePath = path.join(joshuDir, "nylas", "profile.json");
    let profile: Record<string, unknown> = {};
    if (fs.existsSync(profilePath)) {
      try {
        profile = JSON.parse(fs.readFileSync(profilePath, "utf8")) as Record<string, unknown>;
      } catch {
        profile = {};
      }
    }
    writeJson(profilePath, {
      ...profile,
      ownerName: ownerDisplayName,
      assistantName: joshuDisplayName,
      assistantEmail:
        (typeof metadata.agentEmail === "string" && metadata.agentEmail) ||
        (customer?.slug ? `${customer.slug}@joshu.me` : profile.assistantEmail),
    });

    if (soulMd.trim()) {
      fs.mkdirSync(hermesHome, { recursive: true });
      const soulPath = path.join(hermesHome, "SOUL.md");
      fs.writeFileSync(soulPath, `${SOUL_MARKER}\n\n${soulMd.trim()}\n`, { mode: 0o644 });
      console.log(`[sync-local-portal-profile] wrote ${soulPath}`);
    }

    console.log(`[sync-local-portal-profile] owner=${ownerEmail}`);
    console.log(
      `[sync-local-portal-profile] joshu=${joshuDisplayName} companion=${companion?.name ?? "n/a"} slug=${customer?.slug ?? "n/a"}`,
    );
    console.log(`[sync-local-portal-profile] wrote ${path.join(joshuDir, "portal-profile.json")}`);
    console.log(`[sync-local-portal-profile] wrote ${path.join(joshuDir, "identity.json")}`);
    if (draft?.profile?.vibes?.length) {
      console.log(
        `[sync-local-portal-profile] vibes=${draft.profile.vibes.slice(0, 5).join(", ")}…`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
