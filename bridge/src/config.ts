import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import * as z from "zod/v4";

const SEVEN_DAYS_SECONDS = 7 * 86_400;

const GroupPolicySchema = z.object({
  conversationId: z.string().min(1),
  enabled: z.boolean().default(true),
  requireVerifiedIdentity: z.boolean().default(true),
  allowedSenderIds: z.array(z.string().min(1)).default([]),
  requiredPrefix: z.string().default("/agent"),
  projectIds: z.array(z.string().min(1)).default([]),
  allowedActions: z.array(z.string().min(1)).default(["status", "diagnose", "test"]),
  replyPolicy: z.enum(["none", "ack", "informational", "scoped_agent"]).default("scoped_agent")
});

const DeviceConversationSchema = z.object({
  alias: z.string().regex(/^conversation-[0-9a-f]{8}$/),
  displayName: z.string().min(1).max(200),
  assurance: z.enum(["verified", "display_only"]).default("verified"),
  conversationType: z.enum(["direct", "group"]).default("group"),
  groupDelivery: z.enum(["mentions_and_requests", "all"]).default("mentions_and_requests"),
  mentionTerms: z.array(z.string().min(1).max(100)).max(20).default([]),
  contextBefore: z.number().int().min(0).max(20).default(20),
  placementOverride: z.enum(["normal", "folded", "message_box", "unknown"]).optional(),
  enabled: z.boolean().default(true)
});

const DeviceProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  displayName: z.string().min(1).max(200),
  driver: z.enum(["element", "context"]),
  targetBundleEnv: z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/),
  navigationTemplateEnv: z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/),
  discoverDirectConversations: z.boolean().default(false),
  discoverGroupConversations: z.boolean().default(false),
  discoveryConversationLimit: z.number().int().min(1).max(200).default(100),
  discoveryMessageLimit: z.number().int().min(1).max(100).default(100),
  discoveryCatchupSeconds: z.number().int().min(0).max(SEVEN_DAYS_SECONDS).default(3600),
  discoveryActiveWindowSeconds: z.number().int().min(3600).max(SEVEN_DAYS_SECONDS).default(SEVEN_DAYS_SECONDS),
  historyWindowSeconds: z.number().int().min(3600).max(SEVEN_DAYS_SECONDS).default(SEVEN_DAYS_SECONDS),
  historyRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(1),
  backfillRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  conversations: z.array(DeviceConversationSchema).min(1)
});

const ConfigSchema = z.object({
  mode: z.enum(["dry_run", "live"]).default("dry_run"),
  transport: z.enum(["stdio", "http"]).default("stdio"),
  adapter: z.enum(["spool", "device"]).default("spool"),
  runtimeDir: z.string().default("./runtime"),
  stagingDir: z.string().default("./runtime/staging"),
  leaseSeconds: z.number().int().min(30).max(3600).default(300),
  maxLongPollMs: z.number().int().min(0).max(60_000).default(30_000),
  maxAttachmentBytes: z.number().int().positive().default(25 * 1024 * 1024),
  maxReplyChars: z.number().int().min(1).max(10_000).default(2000),
  blockedAttachmentExtensions: z.array(z.string()).default([
    ".exe", ".dll", ".scr", ".com", ".msi", ".msp", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".jse", ".wsf", ".lnk"
  ]),
  presence: z.object({
    quiescentAfterSeconds: z.number().int().min(10).default(120),
    awayAfterSeconds: z.number().int().min(30).default(600),
    requireAwayForLiveReply: z.boolean().default(true)
  }).default({
    quiescentAfterSeconds: 120,
    awayAfterSeconds: 600,
    requireAwayForLiveReply: true
  }),
  http: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(7319),
    tokenEnv: z.string().default("BRIDGE_MCP_BEARER_TOKEN")
  }).default({
    host: "127.0.0.1",
    port: 7319,
    tokenEnv: "BRIDGE_MCP_BEARER_TOKEN"
  }),
  device: z.object({
    pythonPath: z.string().min(1).default("python"),
    cliPath: z.string().min(1).default("./local-adapters/device_connector.py"),
    pollIntervalMs: z.number().int().min(500).max(60_000).default(3000),
    messageLimit: z.number().int().min(1).max(100).default(100),
    ingestHistory: z.boolean().default(false),
    layoutControl: z.object({
      enabled: z.boolean().default(false),
      ownerConnectorId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/).optional(),
      cliPath: z.string().min(1).default("./local-adapters/layout_control.py"),
      pollIntervalMs: z.number().int().min(15_000).max(10 * 60_000).default(60_000),
      administratorOverrideLocalLock: z.boolean().default(true)
    }).default({
      enabled: false,
      cliPath: "./local-adapters/layout_control.py",
      pollIntervalMs: 60_000,
      administratorOverrideLocalLock: true
    }),
    profiles: z.array(DeviceProfileSchema).default([])
  }).default({
    pythonPath: "python",
    cliPath: "./local-adapters/device_connector.py",
    pollIntervalMs: 3000,
    messageLimit: 100,
    ingestHistory: false,
    layoutControl: {
      enabled: false,
      cliPath: "./local-adapters/layout_control.py",
      pollIntervalMs: 60_000,
      administratorOverrideLocalLock: true
    },
    profiles: []
  }),
  defaultUntrustedReplyPolicy: z.enum(["none", "ack", "informational"]).default("informational"),
  groups: z.array(GroupPolicySchema).default([])
});

export type AppConfig = z.infer<typeof ConfigSchema> & {
  configPath: string;
  runtimeDir: string;
  stagingDir: string;
};

export function loadConfig(configPathInput?: string): AppConfig {
  const configPath = resolve(configPathInput ?? process.env.BRIDGE_MCP_CONFIG ?? "./config.json");
  const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) as unknown : {};
  const parsed = ConfigSchema.parse(raw);
  const baseDir = dirname(configPath);
  return {
    ...parsed,
    configPath,
    runtimeDir: resolve(baseDir, parsed.runtimeDir),
    stagingDir: resolve(baseDir, parsed.stagingDir),
    device: {
      ...parsed.device,
      pythonPath: isAbsolute(parsed.device.pythonPath)
        ? parsed.device.pythonPath
        : parsed.device.pythonPath,
      cliPath: resolve(baseDir, parsed.device.cliPath),
      layoutControl: {
        ...parsed.device.layoutControl,
        cliPath: resolve(baseDir, parsed.device.layoutControl.cliPath)
      }
    }
  };
}
