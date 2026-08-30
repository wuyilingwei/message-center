import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../src/config.js";

export function testConfig(root: string, overrides: Partial<AppConfig> = {}): AppConfig {
  const runtimeDir = join(root, "runtime");
  const stagingDir = join(runtimeDir, "staging");
  mkdirSync(stagingDir, { recursive: true });
  return {
    mode: "dry_run",
    transport: "stdio",
    adapter: "spool",
    runtimeDir,
    stagingDir,
    configPath: join(root, "config.json"),
    leaseSeconds: 300,
    maxLongPollMs: 1000,
    maxAttachmentBytes: 25 * 1024 * 1024,
    maxReplyChars: 2000,
    blockedAttachmentExtensions: [".exe", ".dll", ".scr", ".bat", ".cmd", ".ps1"],
    presence: {
      quiescentAfterSeconds: 120,
      awayAfterSeconds: 600,
      requireAwayForLiveReply: true
    },
    http: {
      host: "127.0.0.1",
      port: 7319,
      tokenEnv: "BRIDGE_MCP_BEARER_TOKEN"
    },
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
      profiles: []
    },
    defaultUntrustedReplyPolicy: "informational",
    groups: [{
      conversationId: "group-1",
      enabled: true,
      requireVerifiedIdentity: true,
      allowedSenderIds: ["member-1"],
      requiredPrefix: "/agent",
      projectIds: ["service-a"],
      allowedActions: ["status", "diagnose", "test", "patch_branch"],
      replyPolicy: "scoped_agent"
    }],
    ...overrides
  };
}

export function writeConfig(path: string, config: AppConfig): void {
  writeFileSync(path, `${JSON.stringify({
    mode: config.mode,
    transport: config.transport,
    adapter: config.adapter,
    runtimeDir: config.runtimeDir,
    stagingDir: config.stagingDir,
    leaseSeconds: config.leaseSeconds,
    maxLongPollMs: config.maxLongPollMs,
    maxAttachmentBytes: config.maxAttachmentBytes,
    maxReplyChars: config.maxReplyChars,
    blockedAttachmentExtensions: config.blockedAttachmentExtensions,
    presence: config.presence,
    http: config.http,
    device: config.device,
    defaultUntrustedReplyPolicy: config.defaultUntrustedReplyPolicy,
    groups: config.groups
  }, null, 2)}\n`, "utf8");
}
