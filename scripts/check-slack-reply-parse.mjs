#!/usr/bin/env node
import assert from "node:assert/strict";
import { parseSlackApprovalReply, isJoshuApprovalBotMessage } from "../dist/ownerChannel/slackReplyParse.js";

assert.equal(parseSlackApprovalReply("Y"), "approved");
assert.equal(parseSlackApprovalReply("n"), "denied");
assert.equal(parseSlackApprovalReply("yes please"), "approved");
assert.equal(parseSlackApprovalReply("NO"), "denied");
assert.equal(parseSlackApprovalReply("approve"), "approved");
assert.equal(parseSlackApprovalReply("maybe"), null);
assert.equal(isJoshuApprovalBotMessage("Joshu action approval"), true);
assert.equal(isJoshuApprovalBotMessage("Patrick needs your approval: nylas_send_message"), true);
console.log("check-slack-reply-parse: ok");
