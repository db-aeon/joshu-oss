#!/usr/bin/env node
/**
 * Unit checks for unified mail ingress routing (scheduling → track + hints)
 * and quote-stripped owner→Nylas classifier safety.
 *
 * Usage: npm run test:mail-classifier-routing
 */
import {
  biasOwnerAgentInboxClassification,
  isSchedulingCategoryHint,
  normalizeForIngressRouting,
} from "../dist/ea/classifier.js";
import {
  isCadenceReviewReplySubject,
  isOwnerSubstantiveBody,
  ownerAgentInboxMailClassification,
  ownerMailHasExternalRecipients,
  shouldForceTrackOwnerAgentInbox,
} from "../dist/ea/ownerAgentInboxMail.js";
import { isOwnerReplyEligible } from "../dist/ea/ownerReplyEligibility.js";
import {
  buildClassifierBodyPreview,
  buildThreadBodyPreview,
} from "../dist/connectors/mirrorBodyPreview.js";
import {
  isPureAckOrEmptyBody,
  stripEmailReplyQuotes,
} from "../dist/connectors/emailReplyQuotes.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Legacy scheduling disposition collapses to track
const legacy = normalizeForIngressRouting({
  disposition: "scheduling",
  confidence: 0.9,
  category: "unknown",
  project_slug: null,
  is_new_track: true,
  reason: "cold meet",
});
assert(legacy.disposition === "track", "scheduling disposition → track");
assert(legacy.category === "scheduling", "unknown + legacy scheduling → scheduling category");
assert(legacy.project_slug === "other", "scheduling without slug → other");

// Category scheduling fills other slug
const hinted = normalizeForIngressRouting({
  disposition: "track",
  confidence: 0.85,
  category: "scheduling",
  project_slug: null,
  is_new_track: false,
  reason: "offer times",
});
assert(hinted.project_slug === "other", "scheduling category hint → other slug");
assert(isSchedulingCategoryHint(hinted), "isSchedulingCategoryHint");

// Project slug preserved
const embedded = normalizeForIngressRouting({
  disposition: "track",
  confidence: 0.88,
  category: "scheduling",
  project_slug: "partner-email-assistant",
  is_new_track: false,
  reason: "partner thread",
});
assert(embedded.project_slug === "partner-email-assistant", "keep project slug");

// Quote strip: Gmail "On … wrote:" tail
const ownerAsk = `Ava,

What's on my agenda for tomorrow?

On Sat, Aug 22, 2026, 4:36 PM <ava@joshu.me> wrote:

Sam, I just gave your box an upgrade. Phone & Voice: …`;
const stripped = stripEmailReplyQuotes(ownerAsk);
assert(stripped.includes("agenda for tomorrow"), "keep owner ask");
assert(!stripped.includes("gave your box an upgrade"), "drop quoted upgrade FYI");
assert(!isPureAckOrEmptyBody(stripped), "agenda ask is not a pure ack");
assert(isPureAckOrEmptyBody("Thanks!"), "thanks is pure ack");

// Classifier preview: latest section only + strip quotes (no prior FYI padding)
const mirror = `### Sat — ava@joshu.me

**Subject:** A few upgrades for your box, Sam

Sam, I just gave your box an upgrade. Long FYI about Phone & Voice and Desktop.

---

### Sun — Sam Owner <sam@owner.example>

**Subject:** Re: A few upgrades for your box, Sam

Ava,

What's on my agenda for tomorrow?

On Sat, Aug 22, 2026, 4:36 PM <ava@joshu.me> wrote:

Sam, I just gave your box an upgrade. Long FYI about Phone & Voice and Desktop.
`;
const threadPreview = buildThreadBodyPreview(mirror, 2000);
assert(
  threadPreview.includes("gave your box an upgrade") || threadPreview.includes("Phone & Voice"),
  "thread preview may include prior/quote context",
);
const classPreview = buildClassifierBodyPreview(mirror, 2000);
assert(classPreview.includes("agenda for tomorrow"), "classifier keeps ask");
assert(
  !classPreview.includes("gave your box an upgrade"),
  "classifier drops quoted companion FYI",
);

// Owner Nylas info → track override
const misclass = {
  disposition: "info",
  confidence: 0.78,
  category: "product_development",
  project_slug: null,
  is_new_track: false,
  reason:
    "Owner inbox reply is primarily an FYI about device/software upgrades with no concrete new scheduling or action request.",
};
const fixed = biasOwnerAgentInboxClassification({
  classification: misclass,
  provider: "nylas",
  from: "Sam Owner <sam@owner.example>",
  ownerEmails: ["sam@owner.example"],
  classifierBodyPreview: classPreview,
});
assert(fixed.disposition === "track", "owner nylas info → track");
assert(fixed.reason.includes("owner_nylas_substantive_override"), "override tagged in reason");

// track + owner_sent_update → track + owner_note (owner DONE list)
const sentUpdate = {
  disposition: "track",
  confidence: 0.9,
  category: "owner_sent_update",
  project_slug: null,
  is_new_track: false,
  reason: "Owner status update on cadence thread",
};
const ownerDoneList = `• HOA board vote - DONE
• School course decision (reply Pat)
• Volunteer sign-up - DONE
• Retirement account review - DONE
Weekend trip ideas - KEEP`;
const fixedUpdate = biasOwnerAgentInboxClassification({
  classification: sentUpdate,
  provider: "nylas",
  from: "Sam Owner <sam@work.example>",
  ownerEmails: ["sam@work.example", "sam@owner.example"],
  classifierBodyPreview: ownerDoneList,
});
assert(fixedUpdate.disposition === "track", "owner_sent_update substantive → track");
assert(fixedUpdate.category === "owner_note", "owner_sent_update → owner_note");

// Pure ack stays info
const ack = biasOwnerAgentInboxClassification({
  classification: misclass,
  provider: "nylas",
  from: "sam@owner.example",
  ownerEmails: ["sam@owner.example"],
  classifierBodyPreview: "Thanks!",
});
assert(ack.disposition === "info", "pure ack stays info");

// Non-owner unchanged
const stranger = biasOwnerAgentInboxClassification({
  classification: misclass,
  provider: "nylas",
  from: "other@example.com",
  ownerEmails: ["sam@owner.example"],
  classifierBodyPreview: classPreview,
});
assert(stranger.disposition === "info", "non-owner info unchanged");

// Deterministic owner agent inbox gate
assert(isOwnerSubstantiveBody(ownerDoneList), "DONE list is substantive");
assert(
  shouldForceTrackOwnerAgentInbox({
    provider: "nylas",
    from: "sam@work.example",
    bodyPreview: ownerDoneList,
    ownerEmails: ["sam@work.example"],
  }),
  "force track owner DONE reply",
);
// Owner reply-all to a counterparty with companion CC'd is not an owner→agent note (seen in production 2026-10-02)
const replyAllOwner = ["owner@acme.example"];
const replyAllAgent = ["ava@joshu.me"];
assert(
  !shouldForceTrackOwnerAgentInbox({
    provider: "nylas",
    from: "Jordan Owner <owner@acme.example>",
    bodyPreview: "Pretty open on the 15th. Ava can help schedule thanks!",
    ownerEmails: replyAllOwner,
    agentEmails: replyAllAgent,
    to: ["riley@investor.example"],
    cc: ["ava@joshu.me"],
  }),
  "owner reply-all with external To must reach the classifier",
);
assert(
  shouldForceTrackOwnerAgentInbox({
    provider: "nylas",
    from: "Jordan Owner <owner@acme.example>",
    bodyPreview: "Can you move my Thursday dentist to next week?",
    ownerEmails: replyAllOwner,
    agentEmails: replyAllAgent,
    to: ["ava@joshu.me"],
    cc: ["owner@acme.example"],
  }),
  "owner→agent note still force-tracked",
);
assert(
  ownerMailHasExternalRecipients({
    to: ["Riley <riley@investor.example>"],
    cc: ["ava@joshu.me"],
    ownerEmails: replyAllOwner,
    agentEmails: replyAllAgent,
  }),
  "external recipient detected",
);
assert(
  !ownerMailHasExternalRecipients({
    to: ["Ava <ava@joshu.me>"],
    cc: ["OWNER@acme.example"],
    ownerEmails: replyAllOwner,
    agentEmails: replyAllAgent,
  }),
  "owner + agent only is internal",
);
assert(isCadenceReviewReplySubject("Re: Morning review ready — Thu 9/3"));
const ownerClass = ownerAgentInboxMailClassification();
assert(ownerClass.disposition === "track" && ownerClass.category === "owner_note");
const ownerReply = isOwnerReplyEligible({
  provider: "nylas",
  from: "sam@work.example",
  to: ["ava@joshu.me"],
  ownerEmails: ["sam@work.example"],
  disposition: "track",
  category: "owner_note",
  agentEmails: ["ava@joshu.me"],
});
assert(ownerReply.eligible === true, "owner_note owner-reply eligible");

console.log("mail-classifier-routing checks ok");
