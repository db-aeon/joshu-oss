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
