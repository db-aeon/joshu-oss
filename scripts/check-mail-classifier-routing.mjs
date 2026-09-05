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
  project_slug: "uplabs-email-assistant",
  is_new_track: false,
  reason: "partner thread",
});
assert(embedded.project_slug === "uplabs-email-assistant", "keep project slug");

// Quote strip: Gmail "On … wrote:" tail
const andrewAsk = `Finn,

What's on my agenda for tomorrow?

On Sat, Aug 22, 2026, 4:36 PM <finn@joshu.me> wrote:

Andrew, I just gave your box an upgrade. Phone & Voice: …`;
const stripped = stripEmailReplyQuotes(andrewAsk);
assert(stripped.includes("agenda for tomorrow"), "keep owner ask");
assert(!stripped.includes("gave your box an upgrade"), "drop quoted upgrade FYI");
assert(!isPureAckOrEmptyBody(stripped), "agenda ask is not a pure ack");
assert(isPureAckOrEmptyBody("Thanks!"), "thanks is pure ack");

// Classifier preview: latest section only + strip quotes (no prior FYI padding)
const mirror = `### Sat — finn@joshu.me

**Subject:** A few upgrades for your box, Andrew

Andrew, I just gave your box an upgrade. Long FYI about Phone & Voice and Desktop.

---

### Sun — Andrew Goodrich <ag@andrewgoodrich.com>

**Subject:** Re: A few upgrades for your box, Andrew

Finn,

What's on my agenda for tomorrow?

On Sat, Aug 22, 2026, 4:36 PM <finn@joshu.me> wrote:

Andrew, I just gave your box an upgrade. Long FYI about Phone & Voice and Desktop.
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

// Owner Nylas info → track override (Andrew case)
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
  from: "Andrew Goodrich <ag@andrewgoodrich.com>",
  ownerEmails: ["ag@andrewgoodrich.com"],
  classifierBodyPreview: classPreview,
});
assert(fixed.disposition === "track", "owner nylas info → track");
assert(fixed.reason.includes("owner_nylas_substantive_override"), "override tagged in reason");

// track + owner_sent_update → track + owner_note (Andrew DONE list case)
const sentUpdate = {
  disposition: "track",
  confidence: 0.9,
  category: "owner_sent_update",
  project_slug: null,
  is_new_track: false,
  reason: "Owner status update on cadence thread",
};
const andrewDoneList = `• Cascades cistern board vote - DONE
• St. Mary RE decision (reply Courtney)
• St. Faith's Confirmation - DONE
• mom's annuity-vs-Ally - DONE
Scituate ideas - KEEP`;
const fixedUpdate = biasOwnerAgentInboxClassification({
  classification: sentUpdate,
  provider: "nylas",
  from: "Andrew Goodrich <goodrich@graymediagroup.com>",
  ownerEmails: ["goodrich@graymediagroup.com", "ag@andrewgoodrich.com"],
  classifierBodyPreview: andrewDoneList,
});
assert(fixedUpdate.disposition === "track", "owner_sent_update substantive → track");
assert(fixedUpdate.category === "owner_note", "owner_sent_update → owner_note");

// Pure ack stays info
const ack = biasOwnerAgentInboxClassification({
  classification: misclass,
  provider: "nylas",
  from: "ag@andrewgoodrich.com",
  ownerEmails: ["ag@andrewgoodrich.com"],
  classifierBodyPreview: "Thanks!",
});
assert(ack.disposition === "info", "pure ack stays info");

// Non-owner unchanged
const stranger = biasOwnerAgentInboxClassification({
  classification: misclass,
  provider: "nylas",
  from: "other@example.com",
  ownerEmails: ["ag@andrewgoodrich.com"],
  classifierBodyPreview: classPreview,
});
assert(stranger.disposition === "info", "non-owner info unchanged");

// Deterministic owner agent inbox gate
assert(isOwnerSubstantiveBody(andrewDoneList), "DONE list is substantive");
assert(
  shouldForceTrackOwnerAgentInbox({
    provider: "nylas",
    from: "goodrich@graymediagroup.com",
    bodyPreview: andrewDoneList,
    ownerEmails: ["goodrich@graymediagroup.com"],
  }),
  "force track owner DONE reply",
);
assert(isCadenceReviewReplySubject("Re: Morning review ready — Thu 9/3"));
const ownerClass = ownerAgentInboxMailClassification();
assert(ownerClass.disposition === "track" && ownerClass.category === "owner_note");
const ownerReply = isOwnerReplyEligible({
  provider: "nylas",
  from: "goodrich@graymediagroup.com",
  to: ["finn@joshu.me"],
  ownerEmails: ["goodrich@graymediagroup.com"],
  disposition: "track",
  category: "owner_note",
  agentEmails: ["finn@joshu.me"],
});
assert(ownerReply.eligible === true, "owner_note owner-reply eligible");

console.log("mail-classifier-routing checks ok");
