/** Structured console logging for voice-realtime (grep: voice-realtime). */

export function voiceLog(
  callSid: string | undefined,
  tag: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  const sid = callSid ? ` callSid=${callSid}` : "";
  if (extra && Object.keys(extra).length > 0) {
    console.info(`[voice-realtime]${sid} ${tag} ${message}`, extra);
  } else {
    console.info(`[voice-realtime]${sid} ${tag} ${message}`);
  }
}

export function voiceWarn(
  callSid: string | undefined,
  tag: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  const sid = callSid ? ` callSid=${callSid}` : "";
  if (extra && Object.keys(extra).length > 0) {
    console.warn(`[voice-realtime]${sid} ${tag} ${message}`, extra);
  } else {
    console.warn(`[voice-realtime]${sid} ${tag} ${message}`);
  }
}
