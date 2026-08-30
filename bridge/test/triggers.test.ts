import assert from "node:assert/strict";
import test from "node:test";
import { classifyMessageTrigger } from "../src/triggers.js";

test("direct messages trigger immediately", () => {
  assert.deepEqual(classifyMessageTrigger({
    conversationType: "direct", text: "hello", textElements: [], mentionTerms: [], requiredPrefix: "/agent"
  }), { trigger: "direct", mentioned: false });
});
test("broadcast mentions remain background events", () => {
  assert.deepEqual(classifyMessageTrigger({
    conversationType: "group", text: "@全体成员 deployment complete",
    textElements: [{ content: "@全体成员 deployment complete", atType: 1, atTargetAlias: "member-broadcast" }],
    mentionTerms: [], requiredPrefix: "/agent"
  }), { trigger: "background", mentioned: false });
});

test("personal and configured mentions trigger", () => {
  assert.equal(classifyMessageTrigger({
    conversationType: "group", text: "please inspect",
    textElements: [{ content: "please inspect", atType: 1, atTargetAlias: "member-agent" }],
    mentionTerms: [], requiredPrefix: "/agent"
  }).trigger, "mention");
  assert.equal(classifyMessageTrigger({
    conversationType: "group", text: "@agent please inspect", textElements: [],
    mentionTerms: ["@agent"], requiredPrefix: "/agent"
  }).trigger, "mention");
});

test("explicit request prefixes trigger without a mention", () => {
  assert.deepEqual(classifyMessageTrigger({
    conversationType: "group", text: " /agent status", textElements: [], mentionTerms: [], requiredPrefix: "/agent"
  }), { trigger: "explicit_request", mentioned: false });
});
