/**
 * Owner mobile offer: on an inbound call that the call gate unlocked with the
 * passphrase or the PIN, on a box without an owner mobile, the voice agent asks
 * the owner one time whether to save the caller ID as the owner mobile. Joshu
 * saves the number (POST /api/telephone/owner-mobile/from-call) and never
 * replaces an owner mobile. Spec: openspec change `voice-save-owner-mobile`.
 */
import type { GateMode, UnlockVia } from "./gate/unlockToken.js";

export const SAVE_OWNER_MOBILE_TOOL_NAME = "save_owner_mobile";

/** Numbers Twilio puts in `From` for a blocked, hidden, or unknown caller ID. */
const TWILIO_HIDDEN_CALLER_IDS = new Set(["266696687", "7378742833", "86282452253", "2562533"]);

export type OwnerMobileOffer = {
  /** Caller ID of the call, digits and leading + only. The only number the box saves. */
  caller: string;
  lastDigits: string;
};

export type OwnerMobileOfferInput = {
  caller?: string;
  ownerCaller?: string;
  gate: { mode: GateMode; via: UnlockVia };
};

/** Why a call gets no offer (for the log), or the offer. */
export function ownerMobileOfferFor(
  input: OwnerMobileOfferInput,
): { offer: OwnerMobileOffer } | { skip: string } {
  if (input.gate.mode !== "inbound") return { skip: "callback" };
  if (input.gate.via !== "passphrase" && input.gate.via !== "pin") return { skip: `unlocked via ${input.gate.via}` };
  if (input.ownerCaller?.trim()) return { skip: "owner mobile set" };
  const caller = (input.caller ?? "").replace(/[^\d+]/g, "");
  const digits = caller.replace(/\D/g, "");
  if (digits.length < 10 || TWILIO_HIDDEN_CALLER_IDS.has(digits)) return { skip: "no usable caller ID" };
  return { offer: { caller, lastDigits: digits.slice(-4) } };
}

export type OfferReply = "yes" | "no" | "unclear";

const NO_REPLY =
  /\b(no|nope|nah|not|don'?t|do not|never|later|wait|stop|cancel|other|different|wrong)\b/;
const YES_REPLY =
  /\b(yes|yeah|yep|yup|ya|sure|ok|okay|please|absolutely|definitely|correct|right|go ahead|save it|do it|do that|of course|sounds good)\b/;

/** The reply of the owner to the offer. A "no" word wins over a "yes" word. */
export function classifyOfferReply(text: string | undefined): OfferReply {
  const normalized = (text ?? "").toLowerCase().replace(/[’]/g, "'").replace(/[^a-z' ]+/g, " ");
  if (!normalized.trim()) return "unclear";
  if (NO_REPLY.test(normalized)) return "no";
  return YES_REPLY.test(normalized) ? "yes" : "unclear";
}

/**
 * Save only on a clear yes: the reply the model quoted (or the last transcript when it
 * quoted nothing) is a yes, and the last transcript is not a no. The model hears audio
 * before the transcript lands, so its quote can be newer than the transcript.
 */
export function offerReplyAllowsSave(userQuote: string | undefined, lastTranscript: string | undefined): boolean {
  const reply = userQuote?.trim() ? userQuote : lastTranscript;
  return classifyOfferReply(reply) === "yes" && classifyOfferReply(lastTranscript) !== "no";
}

/** Tool definition, declared only on a call with an offer. */
export const SAVE_OWNER_MOBILE_TOOL = {
  type: "function" as const,
  name: SAVE_OWNER_MOBILE_TOOL_NAME,
  description:
    "Save the number this call comes from as the owner's mobile, so Joshu can text and call them back. Call it only right after the owner clearly said yes to your offer to save this number. Never call it after a no or an unclear answer. The number comes from the call — never pass or ask for a number.",
  parameters: {
    type: "object",
    properties: {
      user_quote: {
        type: "string",
        description: "Verbatim reply of the owner to your offer, e.g. \"yes, save it\".",
      },
    },
    required: ["user_quote"],
  },
};

/** System instruction paragraph for a call with an offer. */
export function ownerMobileOfferContext(offer: OwnerMobileOffer): string {
  return (
    "[Owner mobile] Joshu has no mobile number for the owner, so it cannot text or call them back. " +
    `This call comes from a number ending in ${offer.lastDigits}. Offer ONE time to save it — for example ` +
    `"By the way, want me to save this number, ending in ${offer.lastDigits}, as your mobile, so I can text and call you back?". ` +
    "Make the offer after you reply to the owner's first request, or before your goodbye if they ask for nothing; never in your first turn. " +
    `Call ${SAVE_OWNER_MOBILE_TOOL_NAME} only on a clear yes, and tell the owner what its result says. ` +
    "On a no or no clear answer, save nothing, carry on, and never ask again on this call. Never ask the owner to say a number."
  );
}

/** Tool result text for each outcome (what the model tells the owner). */
export function ownerMobileSaveAnswer(
  outcome: "saved" | "already_tried" | "already_set" | "not_clear_yes" | "invalid" | "failed",
  lastDigits: string,
): string {
  switch (outcome) {
    case "saved":
      return `Saved: the number ending in ${lastDigits} is now the owner's mobile. Tell the owner, in one short sentence, that you can now text and call them back.`;
    case "already_tried":
      return "Nothing more to do: this call already handled the offer. Do not save again and do not ask again.";
    case "already_set":
      return "Not saved: Joshu already has a mobile number for the owner. Tell the owner, and that they can change it in the Telephone app.";
    case "not_clear_yes":
      return "Not saved: the owner did not clearly say yes. Do not ask again on this call; carry on with what they want.";
    case "invalid":
      return "Not saved: this number cannot be used as a mobile. Tell the owner they can add their mobile in the Telephone app. Do not ask for a number.";
    case "failed":
      return "Not saved: Joshu could not save the number right now. Tell the owner they can add their mobile in the Telephone app.";
  }
}
