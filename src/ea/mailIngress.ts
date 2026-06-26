import type { MailAgentAuthorization } from "./agentAuthorization.js";
import type { AfterMirrorThreadInput } from "./triageTypes.js";
import { queueMailIngressTask } from "./mailCron.js";

/** Classified track mail → one Kanban ingress task on ea-mail-ingress. */
export async function forwardTrackMail(
  input: AfterMirrorThreadInput & {
    messageId: string;
    classification: {
      category: string;
      project_slug: string | null;
      is_new_track: boolean;
      reason: string;
      scheduling_hint?: boolean;
      authorization: MailAgentAuthorization;
    };
  },
): Promise<void> {
  const messageId = input.messageId?.trim();
  if (!messageId) {
    console.warn(`[ea-mail] ingress skip missing message_id ${input.provider}/${input.threadId}`);
    return;
  }

  const result = await queueMailIngressTask(input).catch((err) => {
    console.warn(`[ea-mail] ingress queue: ${(err as Error).message}`);
    return { queued: false, reason: "queue_error" as const };
  });

  if (result.reason === "existing_active") {
    console.info(
      `[ea-mail] ingress skip duplicate ${input.provider}/${input.threadId} message=${messageId}`,
    );
  }
}
