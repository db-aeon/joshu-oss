/**
 * Approve a Hermes pairing code from the Safety app (openspec change
 * slack-connect, design decision 5). Hermes keeps only a hash of each pairing
 * code, so the Safety app approves through `hermes pairing approve`.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export type PairingPlatform = "slack" | "telegram";
export const PAIRING_PLATFORMS: readonly PairingPlatform[] = ["slack", "telegram"];

/** Hermes pairing codes: 8 characters from A-Z (no I, O) and 2-9. */
const PAIRING_CODE = /^[A-HJ-NP-Z2-9]{8}$/;

export function normalizePairingCode(raw: string): string | null {
  const code = raw.replace(/[\s`'"-]/g, "").toUpperCase();
  return PAIRING_CODE.test(code) ? code : null;
}

export type PairingApproval = { ok: true; userId: string; userName: string } | { ok: false; error: string };

/** Read the user from the output of `hermes pairing approve`. The command exits 0 also on failure. */
export function parsePairingApproveOutput(stdout: string): PairingApproval {
  const approved = /Approved! User (.+?) on \S+ can now use/.exec(stdout);
  if (approved) {
    const display = approved[1]!.trim();
    const withName = /^(.*) \(([^()]+)\)$/.exec(display);
    return withName
      ? { ok: true, userName: withName[1]!.trim(), userId: withName[2]!.trim() }
      : { ok: true, userName: "", userId: display };
  }
  if (/locked out/i.test(stdout)) {
    return { ok: false, error: "Too many wrong pairing codes. Try again in about one hour." };
  }
  return { ok: false, error: "This pairing code is wrong or expired. Send a new DM to get a new code." };
}

export type ExecFileLike = (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>;

export async function approvePairingCode(opts: {
  hermesBinary: string;
  platform: PairingPlatform;
  code: string;
  execFileImpl?: ExecFileLike;
}): Promise<PairingApproval> {
  const binary = opts.hermesBinary.trim();
  if (!binary) return { ok: false, error: "HERMES_BIN is not configured on this box." };
  const code = normalizePairingCode(opts.code);
  if (!code) return { ok: false, error: "A pairing code has 8 letters and digits." };
  const run = opts.execFileImpl ?? ((file, args, o) => execFile(file, args, o));
  const { stdout } = await run(binary, ["pairing", "approve", opts.platform, code], { timeout: 30_000 });
  return parsePairingApproveOutput(String(stdout));
}
