import { day0ChatCompletion } from "../day0/llm.js";
import { resolveActionExposure } from "./classify.js";

export type ExternalActionClassification = {
  needsApproval: boolean;
  confidence: number;
  reason: string;
};

function resolveClassifierModel(): string {
  return (
    process.env.JOSHU_ACTION_GUARD_CLASSIFIER_MODEL?.trim() ||
    process.env.JOSHU_DAY0_MODEL?.trim() ||
    "openai/gpt-5.4-nano"
  );
}

const EXTERNAL_CLASSIFIER_SYSTEM = `You decide whether an AI agent tool call needs owner approval before execution.
Output JSON only:
{
  "needsApproval": boolean,
  "confidence": number between 0 and 1,
  "reason": "one short line"
}

needsApproval=true when the action has effects outside the private Joshu↔owner channel:
- email/messages to third parties, calendar invites with external attendees, Slack/GitHub/social posts
- browser clicks/types that submit forms, post comments, purchase, or send messages
- any public or third-party-visible side effect

needsApproval=false when effects stay owner-private:
- owner-only email summaries, internal notes, reads/searches/list operations
- browser snapshot/observe/scroll with no submission
- updates that only affect the owner's private draft with no external recipients

When uncertain, set needsApproval=true and lower confidence.`;

export async function classifyExternalAction(
  actionId: string,
  summary: Record<string, unknown>,
): Promise<ExternalActionClassification> {
  const exposure = resolveActionExposure(actionId, summary);
  if (exposure === "external") {
    return { needsApproval: true, confidence: 0.95, reason: "deterministic_external_write" };
  }
  if (exposure === "owner_only") {
    return { needsApproval: false, confidence: 0.95, reason: "deterministic_owner_only" };
  }

  const user = `actionId: ${actionId}\nsummary: ${JSON.stringify(summary).slice(0, 2000)}`;

  try {
    const raw = await day0ChatCompletion(
      [
        { role: "system", content: EXTERNAL_CLASSIFIER_SYSTEM },
        { role: "user", content: user },
      ],
      {
        json: true,
        maxTokens: 128,
        model: resolveClassifierModel(),
        traceName: "action-guard-classifier",
        generationName: "classify-external-action",
        tags: ["action-guard", "classifier"],
        metadata: { actionId },
      },
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const needsApproval = parsed.needsApproval !== false;
    const confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0.5;
    const reason = String(parsed.reason ?? "").trim().slice(0, 200) || "classified";
    return { needsApproval, confidence, reason };
  } catch (err) {
    console.warn(`[action-guard] classifier failed: ${(err as Error).message}`);
    return { needsApproval: true, confidence: 0, reason: "classifier_error_fail_closed" };
  }
}
