/**
 * The avatar that a box sends when it joins a team (spec team-room: at most 64
 * kilobytes, PNG or JPEG). A larger avatar is scaled to 128 x 128 JPEG with ffmpeg
 * (in the box image). When that fails, the box joins without an avatar.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { MAX_AVATAR_BYTES } from "./roomStore.js";
import type { TeamAvatar } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export function imageMime(bytes: Buffer): TeamAvatar["mime"] | undefined {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return undefined;
}

async function scaleWithFfmpeg(bytes: Buffer): Promise<Buffer | undefined> {
  const dir = await mkdtemp(path.join(tmpdir(), "joshu-avatar-"));
  try {
    const input = path.join(dir, "in");
    const output = path.join(dir, "out.jpg");
    await writeFile(input, bytes);
    await execFileAsync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", input, "-vf", "scale=128:128:force_original_aspect_ratio=increase,crop=128:128", "-q:v", "5", output],
      { timeout: 20_000 },
    );
    return await readFile(output);
  } catch (error) {
    console.warn(`[teams] avatar scale failed: ${(error as Error).message}`);
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Avatar from image bytes, scaled when necessary. */
export async function avatarFromBytes(bytes: Buffer): Promise<TeamAvatar | undefined> {
  const mime = imageMime(bytes);
  if (mime && bytes.length <= MAX_AVATAR_BYTES) return { mime, base64: bytes.toString("base64") };
  const scaled = await scaleWithFfmpeg(bytes);
  if (scaled && imageMime(scaled) === "image/jpeg" && scaled.length <= MAX_AVATAR_BYTES) {
    return { mime: "image/jpeg", base64: scaled.toString("base64") };
  }
  return undefined;
}

/** Fetch the avatar of the companion from its URL (identity `avatarUrl` or `imageUrl`). */
export async function fetchCompanionAvatar(url: string | null | undefined): Promise<TeamAvatar | undefined> {
  if (!url || !/^https:\/\//i.test(url)) return undefined;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_SOURCE_BYTES) return undefined;
    return await avatarFromBytes(bytes);
  } catch (error) {
    console.warn(`[teams] avatar fetch failed: ${(error as Error).message}`);
    return undefined;
  }
}
