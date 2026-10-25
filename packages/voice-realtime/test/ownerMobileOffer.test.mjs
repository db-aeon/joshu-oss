import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenerContext } from "../dist/opener.js";
import {
  classifyOfferReply,
  offerReplyAllowsSave,
  ownerMobileOfferFor,
  ownerMobileSaveAnswer,
} from "../dist/ownerMobileOffer.js";

const inbound = (overrides = {}) => ({
  caller: "+13105550199",
  gate: { mode: "inbound", via: "passphrase" },
  ...overrides,
});

test("offer: inbound call unlocked by passphrase or PIN, no owner mobile, usable caller ID", () => {
  assert.deepEqual(ownerMobileOfferFor(inbound()), { offer: { caller: "+13105550199", lastDigits: "0199" } });
  assert.ok("offer" in ownerMobileOfferFor(inbound({ gate: { mode: "inbound", via: "pin" } })));
  assert.ok("offer" in ownerMobileOfferFor(inbound({ caller: "3105550199" })), "10 digits without +1");
});

test("no offer: owner mobile set, callback, trusted caller ID", () => {
  assert.deepEqual(ownerMobileOfferFor(inbound({ ownerCaller: "+13105550100" })), { skip: "owner mobile set" });
  assert.deepEqual(ownerMobileOfferFor(inbound({ gate: { mode: "callback", via: "passphrase" } })), {
    skip: "callback",
  });
  assert.deepEqual(ownerMobileOfferFor(inbound({ gate: { mode: "inbound", via: "trusted" } })), {
    skip: "unlocked via trusted",
  });
});

test("no offer: blocked, hidden, or unusable caller ID", () => {
  for (const caller of [undefined, "", "anonymous", "+266696687", "+7378742833", "+86282452253", "+2562533", "+15551"]) {
    assert.deepEqual(ownerMobileOfferFor(inbound({ caller })), { skip: "no usable caller ID" }, String(caller));
  }
});

test("reply classifier: no wins over yes, unclear saves nothing", () => {
  assert.equal(classifyOfferReply("Yes, save it."), "yes");
  assert.equal(classifyOfferReply("sure"), "yes");
  assert.equal(classifyOfferReply("Yeah please"), "yes");
  assert.equal(classifyOfferReply("No, not this phone"), "no");
  assert.equal(classifyOfferReply("no, wait, yes"), "no");
  assert.equal(classifyOfferReply("Don’t save it"), "no");
  assert.equal(classifyOfferReply("hmm, maybe later"), "no");
  assert.equal(classifyOfferReply("hmm"), "unclear");
  assert.equal(classifyOfferReply("what flights did you find?"), "unclear");
  assert.equal(classifyOfferReply(undefined), "unclear");
});

test("save needs a clear yes, and a no in the transcript wins", () => {
  assert.equal(offerReplyAllowsSave("yes, save it", undefined), true, "quote ahead of the transcript");
  assert.equal(offerReplyAllowsSave("", "Yes please"), true, "transcript when the model quoted nothing");
  assert.equal(offerReplyAllowsSave("yes", "No, not this phone"), false);
  assert.equal(offerReplyAllowsSave("hmm, maybe later", "hmm, maybe later"), false);
  assert.equal(offerReplyAllowsSave(undefined, undefined), false);
});

test("opener context carries the offer only when the call has one", () => {
  const offer = { caller: "+13105550199", lastDigits: "0199" };
  const withOffer = buildOpenerContext("inbound", { items: [] }, offer);
  assert.match(withOffer, /\[Owner mobile\]/);
  assert.match(withOffer, /ending in 0199/);
  assert.match(withOffer, /Offer ONE time/);
  assert.match(withOffer, /never ask again on this call/);
  assert.match(withOffer, /Never ask the owner to say a number/);
  assert.doesNotMatch(buildOpenerContext("inbound", { items: [] }), /\[Owner mobile\]/);
});

test("save answers tell the model what to say", () => {
  assert.match(ownerMobileSaveAnswer("saved", "0199"), /ending in 0199 is now the owner's mobile/);
  assert.match(ownerMobileSaveAnswer("already_set", "0199"), /already has a mobile number/);
  assert.match(ownerMobileSaveAnswer("not_clear_yes", "0199"), /Do not ask again/);
});
