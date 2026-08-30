import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DeviceSessionAdapter,
  normalizeHistoryContinuation,
  resolveConversationProfileMetadata,
  selectDiscoveredRecords,
  type NativeRecord
} from "../src/adapters/device.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { IncomingBridgeMessage } from "../src/types.js";

const DAY = 86_400;

function textRecord(alias: string, msgTime: number, text: string): NativeRecord {
  return {
    messageAlias: alias,
    msgTime,
    sender: { alias: "member-test", nickName: "Member" },
    elements: [{ kind: "text", text: { content: text, atType: 1, needNotify: true } }]
  };
}

test("loads seven-day discovery defaults and accepts a 100-record page", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-history-config-"));
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({
    adapter: "device",
    device: {
      profiles: [{
        id: "primary",
        displayName: "Primary",
        driver: "element",
        targetBundleEnv: "BRIDGE_PRIMARY_TARGET",
        navigationTemplateEnv: "BRIDGE_PRIMARY_NAVIGATION",
        discoveryMessageLimit: 100,
        discoveryCatchupSeconds: 7 * DAY,
        conversations: [{ alias: "conversation-aaaaaaaa", displayName: "Team" }]
      }]
    }
  }), "utf8");
  const config = loadConfig(path);
  const profile = config.device.profiles[0];
  assert.ok(profile);
  assert.equal(profile.discoveryMessageLimit, 100);
  assert.equal(profile.discoveryCatchupSeconds, 7 * DAY);
  assert.equal(profile.discoveryActiveWindowSeconds, 7 * DAY);
  assert.equal(profile.historyWindowSeconds, 7 * DAY);
  assert.equal(profile.historyRevision, 1);
});

test("replays normal group text once per history revision", () => {
  const now = 2_000_000_000;
  const oldMention = textRecord("message-old", now - 6 * DAY, "@agent old request");
  const first = selectDiscoveredRecords([oldMention], {
    time: now - 60,
    aliases: ["message-latest"]
  }, {
    cursorExisted: true,
    catchupSeconds: 3600,
    historyWindowSeconds: 7 * DAY,
    historyRevision: 1,
    allowHistoryBackfill: true,
    nowSeconds: now
  });
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0]?.historyBackfill, true);
  assert.equal(first.historyRevisionApplied, true);

  const second = selectDiscoveredRecords([oldMention], first.nextCursor, {
    cursorExisted: true,
    catchupSeconds: 3600,
    historyWindowSeconds: 7 * DAY,
    historyRevision: 1,
    allowHistoryBackfill: true,
    nowSeconds: now
  });
  assert.deepEqual(second.records, []);
  assert.equal(second.historyRevisionApplied, false);
});

test("routes messages missed by a stale cursor to background instead of immediate", () => {
  const now = 2_000_000_000;
  const missedMention = textRecord("message-missed", now - 6 * DAY, "@agent old request");
  const selected = selectDiscoveredRecords([missedMention], {
    time: now - 7 * DAY,
    aliases: [],
    historyRevision: 1,
    backfillRevision: 1,
  }, {
    cursorExisted: true,
    catchupSeconds: 3600,
    historyWindowSeconds: 7 * DAY,
    historyRevision: 1,
    allowHistoryBackfill: true,
    nowSeconds: now,
  });
  assert.equal(selected.historyRevisionApplied, false);
  assert.equal(selected.records.length, 1);
  assert.equal(selected.records[0]?.historyBackfill, true);
});

test("never revision-backfills direct, folded, stale, or non-text records", () => {
  const now = 2_000_000_000;
  const records: NativeRecord[] = [
    textRecord("message-stale", now - 8 * DAY, "stale"),
    { messageAlias: "message-file", msgTime: now - DAY, elements: [{ kind: "file" }] }
  ];
  const direct = selectDiscoveredRecords(records, { time: now - 60 }, {
    cursorExisted: true,
    catchupSeconds: 3600,
    historyWindowSeconds: 7 * DAY,
    historyRevision: 1,
    allowHistoryBackfill: false,
    nowSeconds: now
  });
  assert.deepEqual(direct.records, []);
  assert.equal(direct.nextCursor.historyRevision, 0);

  const group = selectDiscoveredRecords(records, { time: now - 60 }, {
    cursorExisted: true,
    catchupSeconds: 3600,
    historyWindowSeconds: 7 * DAY,
    historyRevision: 1,
    allowHistoryBackfill: true,
    nowSeconds: now
  });
  assert.deepEqual(group.records, []);
  assert.equal(group.historyRevisionApplied, true);
});

test("an empty new cursor retains its live catch-up baseline", () => {
  const now = 2_000_000_000;
  const selected = selectDiscoveredRecords([], {}, {
    cursorExisted: false,
    catchupSeconds: 3600,
    historyWindowSeconds: 7 * DAY,
    historyRevision: 1,
    allowHistoryBackfill: true,
    nowSeconds: now
  });
  assert.equal(selected.nextCursor.time, now - 3600);
});

test("truncated history advances live state without committing history or card revisions", () => {
  const now = 2_000_000_000;
  const record = textRecord("message-visible", now - 10, "visible");
  const partial = selectDiscoveredRecords([record], {
    time: now - 60,
    aliases: [],
    cardParserRevision: 0,
    historyRevision: 0,
  }, {
    cursorExisted: true,
    catchupSeconds: 3600,
    historyWindowSeconds: 7 * DAY,
    historyRevision: 1,
    allowHistoryBackfill: true,
    historyComplete: false,
    advanceLiveCursor: true,
    nowSeconds: now,
  });
  assert.equal(partial.nextCursor.time, record.msgTime);
  assert.equal(partial.nextCursor.historyIncomplete, true);
  assert.equal(partial.nextCursor.historyRevision, 0);
  assert.equal(partial.nextCursor.cardParserRevision, 0);
  assert.equal(partial.historyRevisionApplied, false);

  const recovered = selectDiscoveredRecords([record], partial.nextCursor, {
    cursorExisted: true,
    catchupSeconds: 3600,
    historyWindowSeconds: 7 * DAY,
    historyRevision: 1,
    allowHistoryBackfill: true,
    historyComplete: true,
    nowSeconds: now,
  });
  assert.equal(recovered.historyRevisionApplied, true);
  assert.equal(recovered.nextCursor.historyIncomplete, false);
  assert.equal(recovered.nextCursor.historyRevision, 1);
});

test("partial history carries an opaque continuation until the revision completes", () => {
  const now = 2_000_000_000;
  const first = selectDiscoveredRecords([
    textRecord("message-first-old", now - 5 * DAY, "first old page")
  ], {
    time: now - 60,
    aliases: ["message-latest"],
    historyRevision: 0,
  }, {
    cursorExisted: true,
    catchupSeconds: 3600,
    historyWindowSeconds: 7 * DAY,
    historyRevision: 1,
    allowHistoryBackfill: true,
    historyComplete: false,
    historyContinuation: { mode: "kernel-msg-id", anchor: "9007199254740993" },
    nowSeconds: now,
  });
  assert.deepEqual(first.records.map((record) => record.messageAlias), ["message-first-old"]);
  assert.equal(first.records[0]?.historyBackfill, true);
  assert.equal(first.historyRevisionApplied, false);
  assert.equal(first.nextCursor.historyIncomplete, true);
  assert.equal(first.nextCursor.historyRevision, 0);
  assert.deepEqual(first.nextCursor.historyContinuation, {
    mode: "kernel-msg-id",
    anchor: "9007199254740993",
  });

  const second = selectDiscoveredRecords([
    textRecord("message-second-old", now - 6 * DAY, "second old page")
  ], first.nextCursor, {
    cursorExisted: true,
    catchupSeconds: 3600,
    historyWindowSeconds: 7 * DAY,
    historyRevision: 1,
    allowHistoryBackfill: true,
    historyComplete: false,
    historyContinuation: { mode: "kernel-msg-id", anchor: "9007199254740000" },
    nowSeconds: now,
  });
  assert.deepEqual(second.records.map((record) => record.messageAlias), ["message-second-old"]);
  assert.deepEqual(second.nextCursor.historyContinuation, {
    mode: "kernel-msg-id",
    anchor: "9007199254740000",
  });

  const completed = selectDiscoveredRecords([], second.nextCursor, {
    cursorExisted: true,
    catchupSeconds: 3600,
    historyWindowSeconds: 7 * DAY,
    historyRevision: 1,
    allowHistoryBackfill: true,
    historyComplete: true,
    nowSeconds: now,
  });
  assert.equal(completed.historyRevisionApplied, true);
  assert.equal(completed.nextCursor.historyRevision, 1);
  assert.equal(completed.nextCursor.historyIncomplete, false);
  assert.equal(completed.nextCursor.historyContinuation, undefined);
});

test("history continuation validation preserves exact integer strings", () => {
  assert.deepEqual(normalizeHistoryContinuation({
    mode: "kernel-msg-id",
    anchor: "9007199254740993",
  }), {
    mode: "kernel-msg-id",
    anchor: "9007199254740993",
  });
  assert.deepEqual(normalizeHistoryContinuation({
    mode: "local-id",
    anchor: "4294967295",
  }), {
    mode: "local-id",
    anchor: "4294967295",
  });
  assert.equal(normalizeHistoryContinuation({ mode: "local-id", anchor: "0" }), undefined);
  assert.equal(normalizeHistoryContinuation({ mode: "local-id", anchor: "4294967296" }), undefined);
  assert.equal(normalizeHistoryContinuation({
    mode: "kernel-msg-id",
    anchor: "9223372036854775808",
  }), undefined);
  assert.equal(normalizeHistoryContinuation({ mode: "kernel-msg-id", anchor: 123 }), undefined);
});

test("failed reads freeze the live cursor and folded scans preserve normal-history recovery", () => {
  const now = 2_000_000_000;
  const cursor = { time: now - 60, aliases: ["message-existing"], historyIncomplete: true };
  const failed = selectDiscoveredRecords([textRecord("message-partial", now - 10, "partial")], cursor, {
    cursorExisted: true,
    catchupSeconds: 3600,
    historyWindowSeconds: 7 * DAY,
    historyRevision: 1,
    allowHistoryBackfill: true,
    historyComplete: false,
    advanceLiveCursor: false,
    nowSeconds: now,
  });
  assert.equal(failed.nextCursor.time, cursor.time);
  assert.deepEqual(failed.nextCursor.aliases, cursor.aliases);
  const folded = selectDiscoveredRecords([], failed.nextCursor, {
    cursorExisted: true,
    catchupSeconds: 3600,
    historyWindowSeconds: 7 * DAY,
    historyRevision: 1,
    allowHistoryBackfill: false,
    historyComplete: true,
    nowSeconds: now,
  });
  assert.equal(folded.nextCursor.historyIncomplete, true);
});

test("device idempotency ledger reuses completed results and quarantines uncertain sends", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-idempotency-"));
  const directory = join(root, "device", "idempotency");
  mkdirSync(directory, { recursive: true });
  const uncertainKey = "command:uncertain";
  const digest = createHash("sha256").update(uncertainKey).digest("hex");
  writeFileSync(join(directory, `${digest}.json`), JSON.stringify({ state: "started" }), "utf8");
  const expiredCompletedKey = "command:expired-completed";
  const expiredCompletedPath = join(directory,
    `${createHash("sha256").update(expiredCompletedKey).digest("hex")}.json`);
  writeFileSync(expiredCompletedPath, JSON.stringify({
    state: "completed", completedAt: "2000-01-01T00:00:00.000Z", result: { receipt: "expired" },
  }), "utf8");
  const adapter = new DeviceSessionAdapter({
    ...loadConfig(join(root, "missing-config.json")),
    runtimeDir: root,
  });
  const internals = adapter as unknown as {
    runIdempotentOperation<T>(key: string, operation: () => Promise<T>): Promise<T>;
  };
  let calls = 0;
  const first = await internals.runIdempotentOperation("command:test", async () => {
    calls += 1;
    return { receipt: "sent" };
  });
  const second = await internals.runIdempotentOperation("command:test", async () => {
    calls += 1;
    return { receipt: "duplicate" };
  });
  assert.deepEqual(first, { receipt: "sent" });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  assert.equal(existsSync(expiredCompletedPath), false);
  assert.equal(existsSync(join(directory, `${digest}.json`)), true);

  await assert.rejects(
    internals.runIdempotentOperation(uncertainKey, async () => ({ receipt: "must-not-send" })),
    /device_send_outcome_uncertain/,
  );

  const failedKey = "command:operation-failed";
  await assert.rejects(
    internals.runIdempotentOperation(failedKey, async () => {
      throw new Error("ssh_transport_lost");
    }),
    /device_send_outcome_uncertain:ssh_transport_lost/,
  );
  await assert.rejects(
    internals.runIdempotentOperation(failedKey, async () => ({ receipt: "must-not-repeat" })),
    /device_send_outcome_uncertain/,
  );

  const notDispatchedKey = "command:not-dispatched";
  await assert.rejects(
    internals.runIdempotentOperation(notDispatchedKey, async () => {
      throw new Error("device_operation_not_dispatched:target-not-running");
    }),
    /device_operation_not_dispatched:target-not-running/,
  );
  assert.deepEqual(
    await internals.runIdempotentOperation(notDispatchedKey, async () => ({ receipt: "safe-retry" })),
    { receipt: "safe-retry" },
  );

  const completionFailureKey = "command:completion-ledger-failed";
  const completionDigest = createHash("sha256").update(completionFailureKey).digest("hex");
  const completionMarker = join(directory, `${completionDigest}.json`);
  const completionTemporary = `${completionMarker}.tmp-${process.pid}`;
  let completionCalls = 0;
  await assert.rejects(
    internals.runIdempotentOperation(completionFailureKey, async () => {
      completionCalls += 1;
      mkdirSync(completionTemporary);
      return { receipt: "native-finished" };
    }),
    /device_send_outcome_uncertain:device_idempotency_completion_failed/,
  );
  assert.equal(existsSync(completionMarker), true);
  await assert.rejects(
    internals.runIdempotentOperation(completionFailureKey, async () => {
      completionCalls += 1;
      return { receipt: "must-not-repeat" };
    }),
    /device_send_outcome_uncertain/,
  );
  assert.equal(completionCalls, 1);
});

test("missing or attempted dispatch receipts are uncertain while explicit pre-dispatch failures can retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-dispatch-receipt-"));
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({
    adapter: "device",
    runtimeDir: "./runtime",
    device: {
      profiles: [{
        id: "primary",
        displayName: "Primary",
        driver: "element",
        targetBundleEnv: "BRIDGE_PRIMARY_TARGET",
        navigationTemplateEnv: "BRIDGE_PRIMARY_NAVIGATION",
        conversations: [{
          alias: "conversation-aaaaaaaa",
          displayName: "Team",
          conversationType: "group",
        }],
      }],
    },
  }), "utf8");
  const adapter = new DeviceSessionAdapter(loadConfig(path));
  let receipt: Record<string, unknown> = {};
  let calls = 0;
  const internals = adapter as unknown as {
    runCli: () => Promise<Record<string, unknown>>;
  };
  internals.runCli = async () => {
    calls += 1;
    return receipt;
  };
  const message: IncomingBridgeMessage = {
    id: "message-test",
    conversation: { id: "conversation-aaaaaaaa", displayName: "Team", assurance: "verified" },
    sender: { id: "member-test", displayName: "Member", assurance: "verified" },
    receivedAt: new Date(0).toISOString(),
    text: "request",
    attachments: [],
    replyHandle: JSON.stringify({ profileId: "primary", conversationId: "conversation-aaaaaaaa" }),
  };

  await assert.rejects(
    adapter.sendReply(message, "response", "receipt:missing"),
    /device_send_outcome_uncertain:unknown/,
  );
  receipt = { dispatched: true, verified: true, sendStatus: "sent" };
  await assert.rejects(
    adapter.sendReply(message, "response", "receipt:missing"),
    /device_send_outcome_uncertain/,
  );
  assert.equal(calls, 1);

  receipt = {
    dispatched: false,
    dispatchAttempted: true,
    verified: false,
    error: "native-return-lost",
  };
  await assert.rejects(
    adapter.sendReply(message, "response", "receipt:attempted"),
    /device_send_outcome_uncertain:native-return-lost/,
  );

  receipt = {
    dispatched: false,
    dispatchAttempted: false,
    verified: false,
    error: "target-unavailable",
  };
  await assert.rejects(
    adapter.sendReply(message, "response", "receipt:not-attempted"),
    /device_operation_not_dispatched:target-unavailable/,
  );
  receipt = { dispatched: true, verified: true, sendStatus: "sent" };
  assert.equal(
    await adapter.sendReply(message, "response", "receipt:not-attempted"),
    "receipt:not-attempted:sent",
  );

  const source = join(root, "attachment.txt");
  writeFileSync(source, "offline attachment", "utf8");
  receipt = { verified: true };
  await assert.rejects(
    adapter.sendConversationFile(
      "conversation-aaaaaaaa",
      source,
      "receipt:file-missing",
      "primary",
    ),
    /device_send_outcome_uncertain:unknown/,
  );
});

test("forces revision replay mentions onto the background text path", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-history-normalize-"));
  const conversation = {
    alias: "conversation-aaaaaaaa",
    displayName: "Team",
    assurance: "verified" as const,
    conversationType: "group" as const,
    groupDelivery: "mentions_and_requests" as const,
    mentionTerms: ["@agent"],
    contextBefore: 20,
    enabled: true
  };
  const profile = {
    id: "primary",
    displayName: "Primary",
    driver: "context" as const,
    targetBundleEnv: "BRIDGE_PRIMARY_TARGET",
    navigationTemplateEnv: "BRIDGE_PRIMARY_NAVIGATION",
    discoverDirectConversations: true,
    discoverGroupConversations: true,
    discoveryConversationLimit: 100,
    discoveryMessageLimit: 100,
    discoveryCatchupSeconds: 3600,
    discoveryActiveWindowSeconds: 7 * DAY,
    historyWindowSeconds: 7 * DAY,
    historyRevision: 1,
    conversations: [conversation]
  };
  const config = {
    ...loadConfig(join(root, "missing-config.json")),
    adapter: "device" as const,
    runtimeDir: root,
    device: {
      pythonPath: "python",
        cliPath: join(root, "local-adapters", "device_connector.py"),
      pollIntervalMs: 3000,
      messageLimit: 100,
      ingestHistory: false,
      layoutControl: {
        enabled: false,
        cliPath: join(root, "local-adapters", "layout_control.py"),
        pollIntervalMs: 60_000,
        administratorOverrideLocalLock: true
      },
      profiles: [profile]
    }
  } satisfies AppConfig;
  const adapter = new DeviceSessionAdapter(config);
  const normalize = adapter as unknown as {
    normalizeRecord(
      profileValue: typeof profile,
      conversationValue: typeof conversation,
      record: NativeRecord,
      placement: "normal"
    ): { trigger?: string; mentioned?: boolean; backupOnly?: boolean; text: string; context?: unknown[] } | null;
  };
  const message = normalize.normalizeRecord(profile, conversation, {
    ...textRecord("message-old", 2_000_000_000 - DAY, "@agent old request"),
    historyBackfill: true,
    contextRecords: [textRecord("message-context", 2_000_000_000 - DAY - 1, "context")]
  }, "normal");
  assert.ok(message);
  assert.equal(message.trigger, "background");
  assert.equal(message.mentioned, false);
  assert.equal(message.backupOnly, true);
  assert.equal(message.text, "@agent old request");
  assert.deepEqual(message.context, []);
});

test("profile metadata accepts new driver fields and old-output fallbacks", () => {
  assert.deepEqual(resolveConversationProfileMetadata({
    channelLabel: "  Channel A  ",
    conversationType: "direct",
    placement: { bucket: "normal" }
  }, { conversationType: "group", placement: "folded" }), {
    channelLabel: "Channel A",
    conversationType: "direct",
    placement: "normal"
  });
  assert.deepEqual(resolveConversationProfileMetadata({ placement: "invalid" }, {
    conversationType: "group",
    placement: "folded"
  }), {
    conversationType: "group",
    placement: "folded"
  });
});

test("uses discovery profiles without one CLI attach per conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-discovery-profile-"));
  const conversation = {
    alias: "conversation-aaaaaaaa",
    displayName: "Configured fallback",
    assurance: "verified" as const,
    conversationType: "group" as const,
    groupDelivery: "mentions_and_requests" as const,
    mentionTerms: [],
    contextBefore: 20,
    enabled: true
  };
  const profile = {
    id: "primary",
    displayName: "Primary",
    driver: "context" as const,
    targetBundleEnv: "BRIDGE_PRIMARY_TARGET",
    navigationTemplateEnv: "BRIDGE_PRIMARY_NAVIGATION",
    discoverDirectConversations: true,
    discoverGroupConversations: true,
    discoveryConversationLimit: 100,
    discoveryMessageLimit: 100,
    discoveryCatchupSeconds: 3600,
    discoveryActiveWindowSeconds: 7 * DAY,
    historyWindowSeconds: 7 * DAY,
    historyRevision: 1,
    conversations: [conversation]
  };
  const config = {
    ...loadConfig(join(root, "missing-config.json")),
    adapter: "device" as const,
    runtimeDir: root,
    device: {
      pythonPath: "python",
        cliPath: join(root, "local-adapters", "device_connector.py"),
      pollIntervalMs: 3000,
      messageLimit: 100,
      ingestHistory: false,
      layoutControl: {
        enabled: false,
        cliPath: join(root, "local-adapters", "layout_control.py"),
        pollIntervalMs: 60_000,
        administratorOverrideLocalLock: true
      },
      profiles: [profile]
    }
  } satisfies AppConfig;
  const adapter = new DeviceSessionAdapter(config);
  let cliCalls = 0;
  const internals = adapter as unknown as {
    conversationNames: Map<string, string>;
    conversationMetadata: Map<string, {
      channelLabel?: string;
      conversationType?: "direct" | "group";
      placement?: "normal" | "folded" | "message_box" | "unknown";
      avatarBase64?: string;
    }>;
    discoveryCoveredConversations: Set<string>;
    runCli: () => Promise<Record<string, unknown>>;
  };
  const key = "primary:conversation-aaaaaaaa";
  internals.conversationNames.set(key, "Discovered title");
  internals.conversationMetadata.set(key, {
    channelLabel: "Channel A",
    conversationType: "group",
    placement: "normal",
    avatarBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")
  });
  internals.discoveryCoveredConversations.add(key);
  internals.runCli = async () => {
    cliCalls += 1;
    throw new Error("unexpected_cli_attach");
  };
  const values = await adapter.listConversationProfiles();
  assert.equal(cliCalls, 0);
  assert.equal(values.length, 1);
  assert.deepEqual({
    displayName: values[0]?.displayName,
    channelLabel: values[0]?.channelLabel,
    conversationType: values[0]?.conversationType,
    placement: values[0]?.placement,
    hasAvatar: Boolean(values[0]?.avatar)
  }, {
    displayName: "Discovered title",
    channelLabel: "Channel A",
    conversationType: "group",
    placement: "normal",
    hasAvatar: true
  });
});

test("device start returns before a long initial discovery completes", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-nonblocking-start-"));
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({
    adapter: "device",
    runtimeDir: "./runtime",
    device: {
      profiles: [{
        id: "primary",
        displayName: "Primary",
        driver: "context",
        targetBundleEnv: "BRIDGE_PRIMARY_TARGET",
        navigationTemplateEnv: "BRIDGE_PRIMARY_NAVIGATION",
        discoverDirectConversations: true,
        conversations: [{ alias: "conversation-aaaaaaaa", displayName: "Team" }]
      }]
    }
  }), "utf8");
  const previousTarget = process.env.BRIDGE_PRIMARY_TARGET;
  process.env.BRIDGE_PRIMARY_TARGET = "com.example.client";
  try {
    const adapter = new DeviceSessionAdapter(loadConfig(path));
    const internals = adapter as unknown as { triggerScan: () => Promise<void> };
    internals.triggerScan = () => new Promise<void>(() => undefined);
    const started = await Promise.race([
      adapter.start(async () => undefined).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))
    ]);
    assert.equal(started, true);
    assert.equal(adapter.connectorHealth().primary?.state, "offline");
    await adapter.stop();
  } finally {
    if (previousTarget === undefined) delete process.env.BRIDGE_PRIMARY_TARGET;
    else process.env.BRIDGE_PRIMARY_TARGET = previousTarget;
  }
});

test("configured fallback reads do not mark a failed discovery profile command-ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-discovery-readiness-"));
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({
    adapter: "device",
    runtimeDir: "./runtime",
    device: {
      profiles: [{
        id: "primary",
        displayName: "Primary",
        driver: "context",
        targetBundleEnv: "BRIDGE_PRIMARY_TARGET",
        navigationTemplateEnv: "BRIDGE_PRIMARY_NAVIGATION",
        discoverDirectConversations: true,
        conversations: [{ alias: "conversation-aaaaaaaa", displayName: "Team" }]
      }]
    }
  }), "utf8");
  const adapter = new DeviceSessionAdapter(loadConfig(path));
  const internals = adapter as unknown as {
    stopped: boolean;
    onMessage: (message: IncomingBridgeMessage) => Promise<void>;
    scan: () => Promise<void>;
    scanDiscoveredConversations: () => Promise<void>;
    scanConversation: () => Promise<void>;
  };
  internals.stopped = false;
  internals.onMessage = async () => undefined;
  internals.scanDiscoveredConversations = async () => {
    throw new Error("temporary_directory_failure");
  };
  internals.scanConversation = async () => undefined;
  await internals.scan();
  assert.equal(adapter.connectorHealth().primary?.state, "offline");
});

test("configured scan commits its cursor only after the spool callback succeeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-configured-cursor-"));
  const runtimeDir = join(root, "runtime");
  const snapshotsDir = join(runtimeDir, "device", "snapshots");
  const cursorsDir = join(runtimeDir, "device", "cursors");
  mkdirSync(snapshotsDir, { recursive: true });
  mkdirSync(cursorsDir, { recursive: true });
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({
    adapter: "device",
    runtimeDir: "./runtime",
    device: {
      profiles: [{
        id: "primary",
        displayName: "Primary",
        driver: "element",
        targetBundleEnv: "BRIDGE_PRIMARY_TARGET",
        navigationTemplateEnv: "BRIDGE_PRIMARY_NAVIGATION",
        conversations: [{
          alias: "conversation-aaaaaaaa",
          displayName: "Team",
          conversationType: "direct",
        }],
      }],
    },
  }), "utf8");
  const config = loadConfig(path);
  const profile = config.device.profiles[0]!;
  const conversation = profile.conversations[0]!;
  const cursorPath = join(cursorsDir, "primary-conversation-aaaaaaaa.json");
  writeFileSync(cursorPath, JSON.stringify({ version: 1, time: 100, aliases: [] }), "utf8");
  const adapter = new DeviceSessionAdapter(config);
  let callbackAttempts = 0;
  let rejectSpool = true;
  const internals = adapter as unknown as {
    onMessage: (message: IncomingBridgeMessage) => Promise<void>;
    runCli: (profileValue: typeof profile, args: string[]) => Promise<Record<string, unknown>>;
    scanConversation: (profileValue: typeof profile, conversationValue: typeof conversation) => Promise<void>;
  };
  internals.onMessage = async () => {
    callbackAttempts += 1;
    if (rejectSpool) throw new Error("spool_failed");
  };
  internals.runCli = async (_profileValue, args) => {
    const output = args[args.indexOf("--output") + 1]!;
    const candidate = args[args.indexOf("--cursor") + 1]!;
    const current = JSON.parse(readFileSync(candidate, "utf8")) as { time?: number };
    const records = Number(current.time || 0) < 200
      ? [textRecord("message-configured-retry", 200, "retry me")]
      : [];
    writeFileSync(output, JSON.stringify({ records }), "utf8");
    writeFileSync(candidate, JSON.stringify({ version: 1, time: 200, aliases: ["message-configured-retry"] }), "utf8");
    return { ok: true };
  };

  await assert.rejects(internals.scanConversation(profile, conversation), /spool_failed/);
  assert.equal(JSON.parse(readFileSync(cursorPath, "utf8")).time, 100);
  rejectSpool = false;
  await internals.scanConversation(profile, conversation);
  assert.equal(callbackAttempts, 2);
  assert.equal(JSON.parse(readFileSync(cursorPath, "utf8")).time, 200);
});

test("configured conversations consume discovery history and commit only after enqueue", async () => {
  const now = 2_000_000_000;
  const root = mkdtempSync(join(tmpdir(), "bridge-configured-discovery-"));
  const runtimeDir = join(root, "runtime");
  const snapshotsDir = join(runtimeDir, "device", "snapshots");
  const cursorsDir = join(runtimeDir, "device", "cursors");
  mkdirSync(snapshotsDir, { recursive: true });
  mkdirSync(cursorsDir, { recursive: true });
  const conversation = {
    alias: "conversation-aaaaaaaa",
    displayName: "Configured team",
    assurance: "verified" as const,
    conversationType: "group" as const,
    groupDelivery: "mentions_and_requests" as const,
    mentionTerms: ["@agent"],
    contextBefore: 20,
    enabled: true
  };
  const profile = {
    id: "primary",
    displayName: "Primary",
    driver: "context" as const,
    targetBundleEnv: "BRIDGE_PRIMARY_TARGET",
    navigationTemplateEnv: "BRIDGE_PRIMARY_NAVIGATION",
    discoverDirectConversations: true,
    discoverGroupConversations: true,
    discoveryConversationLimit: 100,
    discoveryMessageLimit: 100,
    discoveryCatchupSeconds: 3600,
    discoveryActiveWindowSeconds: 7 * DAY,
    historyWindowSeconds: 7 * DAY,
    historyRevision: 1,
    conversations: [conversation]
  };
  const config = {
    ...loadConfig(join(root, "missing-config.json")),
    adapter: "device" as const,
    runtimeDir,
    device: {
      pythonPath: "python",
        cliPath: join(root, "local-adapters", "device_connector.py"),
      pollIntervalMs: 3000,
      messageLimit: 100,
      ingestHistory: false,
      layoutControl: {
        enabled: false,
        cliPath: join(root, "local-adapters", "layout_control.py"),
        pollIntervalMs: 60_000,
        administratorOverrideLocalLock: true
      },
      profiles: [profile]
    }
  } satisfies AppConfig;
  const cursorPath = join(cursorsDir, "primary-conversation-aaaaaaaa.json");
  const historyPath = `${cursorPath}.history.json`;
  writeFileSync(cursorPath, JSON.stringify({ time: now - 60, aliases: ["message-latest"] }), "utf8");
  const adapter = new DeviceSessionAdapter(config);
  const delivered: Array<{ backupOnly: boolean | undefined; trigger: string | undefined }> = [];
  const internals = adapter as unknown as {
    onMessage: (message: { backupOnly?: boolean; trigger?: string }) => Promise<void>;
    runDiscoveryCli: (profileValue: typeof profile, output: string) => Promise<Record<string, unknown>>;
    scanDiscoveredConversations: (profileValue: typeof profile) => Promise<void>;
    discoveryHistoryContinuationInput: (profileValue: typeof profile) => string;
  };
  internals.onMessage = async (message) => {
    delivered.push({ backupOnly: message.backupOnly, trigger: message.trigger });
  };
  internals.runDiscoveryCli = async (_profileValue, output) => {
    writeFileSync(output, JSON.stringify({
      conversations: [{
        alias: conversation.alias,
        displayName: "Discovered configured team",
        conversationType: "group",
        placement: { bucket: "normal" },
        history: {
          mode: "local-id",
          complete: false,
          truncated: true,
          continuation: { mode: "local-id", anchor: "4000000000" },
        },
        records: [textRecord("message-history", now - 6 * DAY, "@agent historical request")]
      }]
    }), "utf8");
    return { ok: true };
  };
  await internals.scanDiscoveredConversations(profile);
  assert.deepEqual(delivered, [{ backupOnly: true, trigger: "background" }]);
  assert.equal(existsSync(historyPath), true);
  const storedHistory = JSON.parse(readFileSync(historyPath, "utf8")) as {
    historyRevision?: number;
    historyIncomplete?: boolean;
    historyContinuation?: { mode?: string; anchor?: string };
  };
  assert.equal(storedHistory.historyRevision, 0);
  assert.equal(storedHistory.historyIncomplete, true);
  assert.deepEqual(storedHistory.historyContinuation, {
    mode: "local-id",
    anchor: "4000000000",
  });
  const continuationInput = JSON.parse(
    readFileSync(internals.discoveryHistoryContinuationInput(profile), "utf8")
  ) as { cursors?: Record<string, unknown> };
  assert.deepEqual(continuationInput.cursors?.[conversation.alias], {
    mode: "local-id",
    anchor: "4000000000",
  });

  const retryRoot = mkdtempSync(join(tmpdir(), "bridge-configured-discovery-retry-"));
  const retryRuntime = join(retryRoot, "runtime");
  mkdirSync(join(retryRuntime, "device", "snapshots"), { recursive: true });
  mkdirSync(join(retryRuntime, "device", "cursors"), { recursive: true });
  const retryCursor = join(retryRuntime, "device", "cursors", "primary-conversation-aaaaaaaa.json");
  writeFileSync(retryCursor, JSON.stringify({ time: now - 60, aliases: ["message-latest"] }), "utf8");
  const retryHistory = `${retryCursor}.history.json`;
  writeFileSync(retryHistory, JSON.stringify({
    version: 1,
    historyRevision: 0,
    backfillRevision: 0,
    historyIncomplete: true,
    historyContinuationRevision: 1,
    historyContinuation: { mode: "local-id", anchor: "4200000000" },
  }), "utf8");
  const retryAdapter = new DeviceSessionAdapter({ ...config, runtimeDir: retryRuntime });
  const retryInternals = retryAdapter as unknown as typeof internals;
  retryInternals.onMessage = async () => { throw new Error("spool_failed"); };
  retryInternals.runDiscoveryCli = internals.runDiscoveryCli;
  await assert.rejects(retryInternals.scanDiscoveredConversations(profile), /spool_failed/);
  const preserved = JSON.parse(readFileSync(retryHistory, "utf8")) as {
    historyContinuation?: { anchor?: string };
  };
  assert.equal(preserved.historyContinuation?.anchor, "4200000000");
});
