/**
 * μ-law codec wrapper — alawmulaw v6 is CJS; `import * as` leaves `.mulaw` undefined under Node ESM.
 */
import alawmulawPkg from "alawmulaw";

type MulawCodec = {
  decode(samples: Uint8Array): Int16Array;
  encode(samples: Int16Array): Uint8Array;
};

const mulaw = (alawmulawPkg as { mulaw: MulawCodec }).mulaw;

export function decodeMulawToPcm16(mulawBytes: Uint8Array): Int16Array {
  return mulaw.decode(mulawBytes);
}

export function encodePcm16ToMulaw(pcm: Int16Array): Uint8Array {
  return mulaw.encode(pcm);
}

/** Twilio inbound: μ-law 8 kHz base64 → PCM16 mono. */
export function mulaw8kB64ToPcm16(b64: string): Int16Array {
  const raw = Buffer.from(b64, "base64");
  if (raw.length === 0) return new Int16Array(0);
  return decodeMulawToPcm16(new Uint8Array(raw));
}

/** Twilio outbound: PCM16 mono → μ-law 8 kHz base64. */
export function pcm16ToMulaw8kB64(pcm: Int16Array): string {
  if (pcm.length === 0) return "";
  return Buffer.from(encodePcm16ToMulaw(pcm)).toString("base64");
}
