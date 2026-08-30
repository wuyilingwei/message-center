import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { downloadAttachment } from "../src/attachments.js";
import { MessageStore } from "../src/store.js";
import type { IncomingBridgeMessage, MessageScope } from "../src/types.js";
import { testConfig } from "./helpers.js";

const scope: MessageScope = {
  trustTier: "trusted",
  projectIds: ["service-a"],
  allowedActions: ["diagnose"],
  replyPolicy: "scoped_agent",
  reason: "test"
};

test("attachment download verifies staging boundary and digest", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-mcp-file-"));
  const config = testConfig(root);
  mkdirSync(config.stagingDir, { recursive: true });
  const bytes = Buffer.from("safe diagnostic log\n", "utf8");
  const stagedPath = join(config.stagingDir, "diagnostic.log");
  writeFileSync(stagedPath, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const store = new MessageStore(join(config.runtimeDir, "queue.sqlite"));
  try {
    const message: IncomingBridgeMessage = {
      id: "message-file",
      conversation: { id: "group-1", displayName: "Team", assurance: "verified" },
      sender: { id: "member-1", displayName: "Engineer", assurance: "verified" },
      receivedAt: new Date().toISOString(),
      text: "/agent inspect log",
      attachments: [{
        id: "attachment-1",
        fileName: "diagnostic.log",
        mimeType: "text/plain",
        sizeBytes: bytes.length,
        sha256,
        stagedPath
      }],
      replyHandle: "reply-file"
    };
    store.enqueue(message, scope);
    const claimed = store.claimNext("worker-1", 30_000);
    assert.ok(claimed);
    const downloaded = await downloadAttachment(config, store, "worker-1", claimed.id, claimed.leaseToken, "attachment-1");
    assert.equal(downloaded.sha256, sha256);
    assert.match(downloaded.localPath, /runtime[\\/]downloads/);
  } finally {
    store.close();
  }
});

test("dangerous executable attachment is blocked", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-mcp-file-"));
  const config = testConfig(root);
  const stagedPath = join(config.stagingDir, "payload.exe");
  writeFileSync(stagedPath, "not executable", "utf8");
  const store = new MessageStore(join(config.runtimeDir, "queue.sqlite"));
  try {
    store.enqueue({
      id: "message-exe",
      conversation: { id: "group-1", displayName: "Team", assurance: "verified" },
      sender: { id: "member-1", displayName: "Engineer", assurance: "verified" },
      receivedAt: new Date().toISOString(),
      text: "/agent run this",
      attachments: [{
        id: "attachment-exe",
        fileName: "payload.exe",
        mimeType: "application/octet-stream",
        sizeBytes: 14,
        stagedPath
      }],
      replyHandle: "reply-exe"
    }, scope);
    const claimed = store.claimNext("worker-1", 30_000);
    assert.ok(claimed);
    await assert.rejects(
      downloadAttachment(config, store, "worker-1", claimed.id, claimed.leaseToken, "attachment-exe"),
      /attachment_type_blocked/
    );
  } finally {
    store.close();
  }
});

test("attachment source outside the staging root is blocked", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-mcp-file-"));
  const config = testConfig(root);
  const outsidePath = join(root, "outside.log");
  writeFileSync(outsidePath, "outside", "utf8");
  const store = new MessageStore(join(config.runtimeDir, "queue.sqlite"));
  try {
    store.enqueue({
      id: "message-outside",
      conversation: { id: "group-1", displayName: "Team", assurance: "verified" },
      sender: { id: "member-1", displayName: "Engineer", assurance: "verified" },
      receivedAt: new Date().toISOString(),
      text: "/agent inspect",
      attachments: [{
        id: "attachment-outside",
        fileName: "outside.log",
        mimeType: "text/plain",
        sizeBytes: 7,
        stagedPath: outsidePath
      }],
      replyHandle: "reply-outside"
    }, scope);
    const claimed = store.claimNext("worker-1", 30_000);
    assert.ok(claimed);
    await assert.rejects(
      downloadAttachment(config, store, "worker-1", claimed.id, claimed.leaseToken, "attachment-outside"),
      /attachment_source_outside_staging_root/
    );
  } finally {
    store.close();
  }
});
