import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MessageStore } from "../src/store.js";
import type { IncomingBridgeMessage, MessageScope } from "../src/types.js";

const scope: MessageScope = {
  trustTier: "trusted",
  projectIds: ["service-a"],
  allowedActions: ["diagnose"],
  replyPolicy: "scoped_agent",
  reason: "test"
};

function message(): IncomingBridgeMessage {
  return {
    id: "message-1",
    conversation: { id: "group-1", displayName: "Team", assurance: "verified" },
    sender: { id: "member-1", displayName: "Engineer", assurance: "verified" },
    receivedAt: new Date().toISOString(),
    text: "/agent diagnose",
    attachments: [],
    replyHandle: "reply-1"
  };
}

test("message leasing and reply idempotency are enforced", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-mcp-store-"));
  const store = new MessageStore(join(root, "queue.sqlite"));
  try {
    assert.equal(store.enqueue(message(), scope), true);
    assert.equal(store.enqueue(message(), scope), false);
    const claimed = store.claimNext("worker-1", 30_000);
    assert.ok(claimed);
    assert.throws(() => store.getClaimedMessage(claimed.id, "00000000-0000-4000-8000-000000000000"), /invalid_message_lease/);

    const first = store.beginReply(claimed.id, claimed.leaseToken, "request-0001", "done", "dry_run", "worker-1");
    const second = store.beginReply(claimed.id, claimed.leaseToken, "request-0001", "done", "dry_run", "worker-1");
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.result.replyId, second.result.replyId);

    store.complete(claimed.id, claimed.leaseToken, "worker-1", "completed");
    assert.equal(store.pendingCount(), 0);
  } finally {
    store.close();
  }
});
