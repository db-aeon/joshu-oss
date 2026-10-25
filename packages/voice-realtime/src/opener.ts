/**
 * The first turn of a gated call.
 *
 * The caller was authenticated by the gate before the model joined, so the
 * model has heard nothing: Joshu gives it the owner's context up front (system
 * instruction) and exactly one opening turn, written here. No passphrase
 * residue, no double greeting, nothing to guess.
 */
import { HERMES_API_KEY } from "./config.js";
import type { GateMode } from "./gate/unlockToken.js";
import { ownerMobileOfferContext, type OwnerMobileOffer } from "./ownerMobileOffer.js";
import { voiceWarn } from "./voiceLog.js";

const JOSHU_API_BASE = (process.env.JOSHU_API_BASE_URL ?? "http://127.0.0.1:8788/joshu").replace(/\/+$/, "");

export type OpenerItem = { id: string; kind: string; title: string; text: string };

export type OpenerPayload = {
  /** Broker snapshot (active, blocked, recently finished work) for the owner. */
  context?: string;
  /** Results the owner has not heard (inbound calls), now offered on this call. */
  items: OpenerItem[];
};

/**
 * Ask Joshu for the call's opening context. Also reports the owner as on an
 * unlocked call (no callbacks while they are here). Undefined when Joshu is
 * unreachable — the call still opens, with a plain greeting.
 */
export async function fetchOpener(
  callSid: string,
  mode: GateMode,
  timeoutMs = 2_500,
): Promise<OpenerPayload | undefined> {
  try {
    const response = await fetch(`${JOSHU_API_BASE}/api/realtime-goals/voice/opener`, {
      method: "POST",
      headers: { Authorization: `Bearer ${HERMES_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ callSid, mode }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = (await response.json()) as { context?: unknown; items?: unknown };
    const items = Array.isArray(json.items)
      ? (json.items as OpenerItem[]).filter(
          (item) => item && typeof item.id === "string" && typeof item.text === "string" && item.text.trim(),
        )
      : [];
    return {
      ...(typeof json.context === "string" && json.context.trim() ? { context: json.context.trim() } : {}),
      items,
    };
  } catch (error) {
    voiceWarn(callSid, "opener", "opener context unavailable", { error: (error as Error).message });
    return undefined;
  }
}

/** Standing context for the model, added to its system instruction at setup. */
export function buildOpenerContext(
  mode: GateMode,
  payload: OpenerPayload | undefined,
  ownerMobileOffer?: OwnerMobileOffer,
): string {
  const parts = [
    mode === "callback"
      ? "[This call] Joshu placed this OUTBOUND call to the owner to report on background work they asked for earlier — they did not call you. The owner already passed the passphrase check before you joined. Joshu hands you the update as the first turn: open by saying why you called, then relay it."
      : "[This call] The owner called in and already passed the passphrase check before you joined — you did not hear it, and nothing has failed. Joshu gives you the opening line as the first turn.",
  ];
  if (payload?.items.length) {
    parts.push(
      "[Results the owner has NOT heard yet — relay them when the owner wants them, keeping every time, price, and name exactly as written]\n" +
        payload.items.map((item) => `- ${item.title}: ${item.text}`).join("\n"),
    );
  }
  if (payload?.context) {
    parts.push(
      `[Background work context — for your awareness; read it only if the owner asks]\n${payload.context}`,
    );
  }
  if (ownerMobileOffer) parts.push(ownerMobileOfferContext(ownerMobileOffer));
  return parts.join("\n\n");
}

function quotedList(titles: string[]): string {
  const quoted = titles.map((title) => `“${title}”`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

/** The inbound opening turn: greet by name, offer unheard results, then wait. */
export function buildInboundOpenerTurn(ownerName: string, items: OpenerItem[]): string {
  const name = ownerName && ownerName !== "Owner" ? ownerName : "";
  const hi = name ? `Hi ${name}` : "Hi";
  if (items.length === 0) {
    return (
      "[Joshu: the call just connected. This is your first turn.]\n" +
      `Greet the owner${name ? " by name" : ""} and ask what you can do for them, in one short sentence — for example "${hi}, what can I do for you?". ` +
      "Say nothing else and call no tools. Then wait for them."
    );
  }
  const example =
    items.length === 1
      ? `"${hi} — your ${items[0]!.title} results are ready. Want to hear them?"`
      : `"${hi} — I have ${items.length} updates ready for you. Want to hear them?"`;
  return (
    "[Joshu: the call just connected. This is your first turn.]\n" +
    `Results the owner asked for earlier are ready and they have not heard them: ${quotedList(items.map((item) => item.title))}. ` +
    `Greet the owner${name ? " by name" : ""}, say in one short sentence that they are ready, and ask whether they want to hear them now — for example ${example} ` +
    "Do not read the results yet and call no tools. Then wait for them."
  );
}
