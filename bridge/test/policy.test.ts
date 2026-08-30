import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateMessagePolicy } from "../src/policy.js";
import type { IncomingBridgeMessage } from "../src/types.js";
import { testConfig } from "./helpers.js";

function message(overrides: Partial<IncomingBridgeMessage> = {}): IncomingBridgeMessage {
  return {
    id: "message-1",
    conversation: { id: "group-1", displayName: "Team", assurance: "verified" },
    sender: { id: "member-1", displayName: "Engineer", assurance: "verified" },
    receivedAt: new Date().toISOString(),
    text: "/agent diagnose service-a",
    attachments: [],
    replyHandle: "reply-1",
    ...overrides
  };
}

test("trusted policy returns only enrolled project scope", () => {
  const config = testConfig(mkdtempSync(join(tmpdir(), "bridge-mcp-policy-")));
  const scope = evaluateMessagePolicy(config, message());
  assert.equal(scope.trustTier, "trusted");
  assert.deepEqual(scope.projectIds, ["service-a"]);
  assert.ok(scope.allowedActions.includes("diagnose"));
});

test("display-only identity cannot gain trusted access", () => {
  const config = testConfig(mkdtempSync(join(tmpdir(), "bridge-mcp-policy-")));
  const scope = evaluateMessagePolicy(config, message({
    conversation: { id: "group-1", displayName: "Team", assurance: "display_only" }
  }));
  assert.equal(scope.trustTier, "rejected");
  assert.deepEqual(scope.projectIds, []);
  assert.equal(scope.replyPolicy, "none");
});

test("unenrolled conversation has no project or action scope", () => {
  const config = testConfig(mkdtempSync(join(tmpdir(), "bridge-mcp-policy-")));
  const scope = evaluateMessagePolicy(config, message({
    conversation: { id: "unknown-group", displayName: "Lookalike", assurance: "verified" }
  }));
  assert.equal(scope.trustTier, "untrusted");
  assert.deepEqual(scope.projectIds, []);
  assert.deepEqual(scope.allowedActions, []);
});
