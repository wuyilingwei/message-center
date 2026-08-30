import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { SerialExecutor } from "../async-coordination.js";
import type { AppConfig } from "../config.js";
import type {
  BridgeAdapter,
  ConversationPlacement,
  ConversationProfile,
  ConversationType,
  ConversationFileInventory,
  DownloadedConversationFile,
  IncomingAttachment,
  IncomingBridgeMessage,
  SentConversationFile
} from "../types.js";
import { classifyMessageTrigger } from "../triggers.js";

const execFileAsync = promisify(execFile);
const CARD_PARSER_REVISION = 1;
const CARD_RECONCILE_WINDOW_SECONDS = 24 * 60 * 60;
const IDEMPOTENCY_COMPLETED_RETENTION_MS = 90 * 24 * 60 * 60_000;
const IDEMPOTENCY_COMPLETED_LIMIT = 100_000;
const IDEMPOTENCY_PRUNE_INTERVAL_MS = 60 * 60_000;

export interface NativeElement {
  elementType?: number;
  kind?: string;
  text?: {
    content?: string;
    atType?: number;
    atTargetAlias?: string;
    needNotify?: boolean;
  };
  picture?: { assetAlias?: string; fileName?: string; fileSize?: number };
  file?: { assetAlias?: string; fileName?: string; fileSize?: number };
  voice?: { assetAlias?: string; fileName?: string; fileSize?: number; transcript?: string };
  video?: { assetAlias?: string; fileName?: string; fileSize?: number };
  marketFace?: { summary?: string; packId?: string; faceId?: string };
  card?: {
    cardType?: "transfer" | "pat" | "app";
    title?: string;
    summary?: string;
    amount?: string;
    status?: string;
    source?: string;
  };
}

export interface NativeRecord {
  messageAlias?: string;
  msgTime?: number;
  messageType?: number;
  text?: string;
  isSelf?: boolean;
  sender?: { alias?: string; remarkName?: string; memberName?: string; nickName?: string };
  elements?: NativeElement[];
  contextRecords?: NativeRecord[];
  historyBackfill?: boolean;
  observedAt?: string;
}

interface NativeDiscoveredConversation {
  alias?: string;
  displayName?: string;
  channelLabel?: string;
  conversationType?: string;
  placement?: { bucket?: string };
  pinned?: boolean;
  unreadCount?: number;
  unreadObservedAt?: string;
  lastMessagePreview?: string;
  lastMessageAt?: number;
  messageCount?: number;
  messageReadError?: string;
  history?: { complete?: boolean; truncated?: boolean; continuation?: unknown };
  avatarBase64?: string;
  records?: NativeRecord[];
}

interface NativeDiscoveryPayload {
  channelLabel?: string;
  conversations?: NativeDiscoveredConversation[];
}

interface NativeMessagePayload {
  records?: NativeRecord[];
  conversationPlacement?: {
    bucket?: string;
  };
}

export interface NativeConversationProfile {
  alias?: string;
  displayName?: string;
  channelLabel?: string;
  conversationType?: string;
  placement?: string | { bucket?: string };
  avatar?: {
    path?: string;
    mimeType?: string;
    sizeBytes?: number;
    sha256?: string;
  } | null;
}

type DeviceProfile = AppConfig["device"]["profiles"][number];
type DeviceConversation = DeviceProfile["conversations"][number];

export interface ConversationRuntimeMetadata {
  channelLabel?: string;
  conversationType?: ConversationType;
  placement?: ConversationPlacement;
  avatarBase64?: string;
  pinned?: boolean;
  unreadCount?: number;
  unreadObservedAt?: string;
  lastMessagePreview?: string;
  lastMessageAt?: string;
}

export interface DiscoveredRecordCursor {
  version?: number;
  time?: number;
  aliases?: string[];
  cardParserRevision?: number;
  historyRevision?: number;
  backfillRevision?: number;
  historyIncomplete?: boolean;
  historyContinuation?: HistoryContinuation;
  historyContinuationRevision?: number;
}

export interface HistoryContinuation {
  mode: string;
  anchor: string;
}

export interface DiscoveredRecordSelectionOptions {
  cursorExisted: boolean;
  catchupSeconds: number;
  historyWindowSeconds: number;
  historyRevision: number;
  allowHistoryBackfill: boolean;
  historyComplete?: boolean;
  advanceLiveCursor?: boolean;
  historyContinuation?: HistoryContinuation;
  nowSeconds?: number;
}

const MAX_PROFILE_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_PROFILE_AVATAR_BASE64_LENGTH = Math.ceil(MAX_PROFILE_AVATAR_BYTES / 3) * 4;

function parseLastJson(stdout: string): Record<string, unknown> {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Diagnostic output may precede the final JSON result.
    }
  }
  throw new Error("device_cli_returned_no_json");
}

function isLegacyDiscoveryArgumentError(error: unknown): boolean {
  const details = `${error instanceof Error ? error.message : String(error)}\n${
    String((error as { stderr?: unknown } | null)?.stderr ?? "")
  }`;
  return /(?:invalid choice|unrecognized arguments)/i.test(details) &&
    /--(?:message-limit|history-window-seconds)/i.test(details);
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function decodeImage(value: string | undefined): { bytes: Buffer; mimeType: string; extension: string } | undefined {
  const encoded = value?.replace(/\s/g, "") ?? "";
  if (!encoded || encoded.length > MAX_PROFILE_AVATAR_BASE64_LENGTH || !/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) {
    return undefined;
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 8 || bytes.length > MAX_PROFILE_AVATAR_BYTES) return undefined;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { bytes, mimeType: "image/png", extension: "png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { bytes, mimeType: "image/jpeg", extension: "jpg" };
  }
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") {
    return { bytes, mimeType: "image/gif", extension: "gif" };
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return { bytes, mimeType: "image/webp", extension: "webp" };
  }
  return undefined;
}

export function elementText(element: NativeElement): string {
  if (element.kind === "text") return element.text?.content ?? "";
  if (element.kind === "picture") return `[picture:${element.picture?.assetAlias ?? "asset"}]`;
  if (element.kind === "file") return `[file:${element.file?.fileName ?? element.file?.assetAlias ?? "asset"}]`;
  if (element.kind === "voice") {
    return element.voice?.transcript?.trim() || `[voice:${element.voice?.assetAlias ?? "asset"}]`;
  }
  if (element.kind === "video") return `[video:${element.video?.assetAlias ?? "asset"}]`;
  if (element.kind === "market-face") {
    return `[sticker:${element.marketFace?.summary || element.marketFace?.faceId || "asset"}]`;
  }
  if (element.kind === "card") {
    const card = element.card ?? {};
    if (card.cardType === "transfer") {
      const detail = [card.amount, card.summary, card.status]
        .map((item) => item?.trim())
        .filter(Boolean)
        .join(" · ");
      return detail ? `[转账] ${detail}` : `[转账] ${card.title || "转账"}`;
    }
    if (card.cardType === "pat") {
      return card.summary?.trim() ? `[拍一拍] ${card.summary.trim()}` : "[拍一拍]";
    }
    const detail = [card.title, card.summary, card.source]
      .map((item) => item?.trim())
      .filter(Boolean)
      .join(" · ");
    return detail ? `[卡片] ${detail}` : "[卡片]";
  }
  return `[${element.kind || "opaque"}:type-${element.elementType ?? 0}]`;
}

function recordText(record: NativeRecord): string {
  return (record.elements ?? []).map(elementText).filter(Boolean).join("\n");
}

function recordPlainText(record: NativeRecord): string {
  return (record.elements ?? [])
    .filter((element) => element.kind === "text")
    .map((element) => element.text?.content ?? "")
    .filter(Boolean)
    .join("\n");
}

export function shouldReconcileCard(
  record: NativeRecord,
  parserRevision: number,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  return parserRevision < CARD_PARSER_REVISION &&
    Number(record.msgTime || 0) >= nowSeconds - CARD_RECONCILE_WINDOW_SECONDS &&
    (record.elements ?? []).some((element) => element.kind === "card");
}

function placement(value: unknown): "normal" | "folded" | "message_box" | "unknown" {
  return new Set(["normal", "folded", "message_box"]).has(String(value))
    ? String(value) as "normal" | "folded" | "message_box"
    : "unknown";
}

function optionalPlacement(value: unknown): ConversationPlacement | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    return optionalPlacement((value as { bucket?: unknown }).bucket);
  }
  return new Set(["normal", "folded", "message_box", "unknown"]).has(String(value))
    ? String(value) as ConversationPlacement
    : undefined;
}

function optionalConversationType(value: unknown): ConversationType | undefined {
  return value === "direct" || value === "group" ? value : undefined;
}

function optionalChannelLabel(value: unknown): string | undefined {
  const label = typeof value === "string" ? value.trim().slice(0, 80) : "";
  return label || undefined;
}

export function normalizeHistoryContinuation(value: unknown): HistoryContinuation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { mode?: unknown; anchor?: unknown };
  const mode = typeof candidate.mode === "string" ? candidate.mode : "";
  const anchor = typeof candidate.anchor === "string" ? candidate.anchor : "";
  if (!/^[a-z0-9-]{1,40}$/.test(mode) || !/^-?\d{1,24}$/.test(anchor)) return undefined;
  if (mode === "local-id" && (
    !/^\d{1,10}$/.test(anchor) || BigInt(anchor) < 1n || BigInt(anchor) > 0xffff_ffffn
  )) return undefined;
  if (mode === "kernel-msg-id" && (
    !/^-?\d{1,19}$/.test(anchor) || BigInt(anchor) < -(1n << 63n) || BigInt(anchor) >= (1n << 63n)
  )) return undefined;
  return { mode, anchor };
}

export function resolveConversationProfileMetadata(
  native: Pick<NativeConversationProfile, "channelLabel" | "conversationType" | "placement">,
  fallback: ConversationRuntimeMetadata
): Pick<ConversationProfile, "channelLabel" | "conversationType" | "placement"> {
  const channelLabel = optionalChannelLabel(native.channelLabel) ?? fallback.channelLabel;
  const conversationType = optionalConversationType(native.conversationType) ?? fallback.conversationType;
  const nativePlacement = optionalPlacement(native.placement);
  const conversationPlacement = nativePlacement ?? fallback.placement;
  return {
    ...(channelLabel ? { channelLabel } : {}),
    ...(conversationType ? { conversationType } : {}),
    ...(conversationPlacement ? { placement: conversationPlacement } : {})
  };
}

export function selectDiscoveredRecords(
  records: NativeRecord[],
  cursor: DiscoveredRecordCursor,
  options: DiscoveredRecordSelectionOptions
): { records: NativeRecord[]; nextCursor: DiscoveredRecordCursor; historyRevisionApplied: boolean } {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const cursorTime = options.cursorExisted
    ? Math.max(0, Number(cursor.time || 0))
    : Math.max(0, nowSeconds - options.catchupSeconds);
  const cursorAliases = new Set(cursor.aliases ?? []);
  const cardParserRevision = Math.max(0, Number(cursor.cardParserRevision || 0));
  const recordedHistoryRevision = Math.max(
    0,
    Number(cursor.historyRevision || 0),
    Number(cursor.backfillRevision || 0)
  );
  const desiredHistoryRevision = Math.max(0, Math.floor(options.historyRevision));
  const historyComplete = options.historyComplete !== false;
  const historyPending = options.allowHistoryBackfill &&
    (desiredHistoryRevision > recordedHistoryRevision || cursor.historyIncomplete === true);
  const historyRevisionApplied = historyPending && historyComplete;
  const liveEnabled = options.cursorExisted || options.catchupSeconds > 0;
  const liveCutoff = nowSeconds - Math.max(0, options.catchupSeconds);
  const unseenRecord = (record: NativeRecord): boolean => {
    const messageTime = Number(record.msgTime || 0);
    return messageTime > cursorTime ||
      (messageTime === cursorTime && Boolean(record.messageAlias) &&
        !cursorAliases.has(String(record.messageAlias)));
  };
  const fresh = liveEnabled ? records.filter((record) => {
    const messageTime = Number(record.msgTime || 0);
    return messageTime >= liveCutoff &&
      (unseenRecord(record) || shouldReconcileCard(record, cardParserRevision, nowSeconds));
  }) : [];
  const freshRecords = new Set(fresh);
  const historyCutoff = nowSeconds - options.historyWindowSeconds;
  const backfill = options.allowHistoryBackfill ? records
    .filter((record) => !freshRecords.has(record) &&
      (historyPending || unseenRecord(record)) &&
      Boolean(record.messageAlias) &&
      Number(record.msgTime || 0) >= historyCutoff &&
      Boolean(recordPlainText(record).trim()))
    .map((record) => ({ ...record, historyBackfill: true })) : [];
  const selected = [...fresh, ...backfill].sort((left, right) => {
    const timeDifference = Number(left.msgTime || 0) - Number(right.msgTime || 0);
    return timeDifference || String(left.messageAlias || "").localeCompare(String(right.messageAlias || ""));
  });

  const latestObservedTime = records.length > 0
    ? Math.max(...records.map((record) => Number(record.msgTime || 0)))
    : 0;
  const existingTime = options.cursorExisted ? Math.max(0, Number(cursor.time || 0)) : cursorTime;
  const advanceLiveCursor = options.advanceLiveCursor !== false;
  const nextTime = advanceLiveCursor ? Math.max(existingTime, latestObservedTime) : existingTime;
  let nextAliases = [...cursorAliases];
  if (advanceLiveCursor && latestObservedTime > existingTime && latestObservedTime === nextTime) {
    nextAliases = records
      .filter((record) => Number(record.msgTime || 0) === latestObservedTime && record.messageAlias)
      .map((record) => String(record.messageAlias));
  } else if (advanceLiveCursor && latestObservedTime > 0 && latestObservedTime === nextTime) {
    nextAliases = [...new Set([
      ...nextAliases,
      ...records
        .filter((record) => Number(record.msgTime || 0) === latestObservedTime && record.messageAlias)
        .map((record) => String(record.messageAlias))
    ])];
  }
  const nextHistoryRevision = historyRevisionApplied ? desiredHistoryRevision : recordedHistoryRevision;
  const existingContinuation = cursor.historyContinuationRevision === desiredHistoryRevision
    ? normalizeHistoryContinuation(cursor.historyContinuation) : undefined;
  const nextContinuation = historyPending && !historyComplete
    ? normalizeHistoryContinuation(options.historyContinuation) ?? existingContinuation
    : undefined;
  return {
    records: selected,
    nextCursor: {
      version: 1,
      time: nextTime,
      aliases: nextAliases.sort(),
      cardParserRevision: historyComplete ? CARD_PARSER_REVISION : cardParserRevision,
      historyRevision: nextHistoryRevision,
      backfillRevision: nextHistoryRevision,
      historyIncomplete: options.allowHistoryBackfill
        ? historyPending && !historyComplete
        : cursor.historyIncomplete === true,
      ...(nextContinuation ? {
        historyContinuation: nextContinuation,
        historyContinuationRevision: desiredHistoryRevision
      } : {})
    },
    historyRevisionApplied
  };
}

function requireVerifiedDispatchReceipt(result: Record<string, unknown>): void {
  const detail = String(result.error ?? "unknown");
  // A retry is safe only when the adapter explicitly proves native dispatch was
  // not attempted. Missing legacy receipt fields are an uncertain outcome.
  if (result.dispatched === false && result.dispatchAttempted !== true) {
    throw new Error(`device_operation_not_dispatched:${detail}`);
  }
  if (result.dispatched !== true || result.verified !== true) {
    throw new Error(`device_send_outcome_uncertain:${detail}`);
  }
}

function recordSender(record: NativeRecord): { id: string; name: string } {
  const sender = record.sender ?? {};
  const id = sender.alias || "member-unknown";
  return { id, name: sender.remarkName || sender.memberName || sender.nickName || id };
}

export class DeviceSessionAdapter implements BridgeAdapter {
  readonly name = "device";
  readonly canSendWhileLocked = true;
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;
  private scanTask: Promise<void> | undefined;
  private onMessage: ((message: IncomingBridgeMessage) => Promise<void>) | undefined;
  private readonly conversationNames = new Map<string, string>();
  private readonly discoveredConversations = new Map<string, Map<string, DeviceConversation>>();
  private readonly conversationMetadata = new Map<string, ConversationRuntimeMetadata>();
  private readonly discoveryCoveredConversations = new Set<string>();
  private readonly profileHealth = new Map<string, { state: "online" | "offline"; observedAt: string }>();
  private readonly cliExecutor = new SerialExecutor();
  private readonly layoutControlExecutor = new SerialExecutor();
  private readonly discoveryCliModes = new Map<string, "modern" | "message-20" | "legacy">();
  private lastIdempotencyPruneAt = 0;

  constructor(private readonly config: AppConfig) {}

  async start(onMessage: (message: IncomingBridgeMessage) => Promise<void>): Promise<void> {
    if (this.config.device.profiles.length === 0) throw new Error("device_profiles_required");
    for (const profile of this.config.device.profiles) this.validateProfileEnvironment(profile);
    this.onMessage = onMessage;
    this.stopped = false;
    mkdirSync(join(this.config.runtimeDir, "device", "snapshots"), { recursive: true });
    mkdirSync(join(this.config.runtimeDir, "device", "cursors"), { recursive: true });
    const observedAt = new Date().toISOString();
    for (const profile of this.config.device.profiles) {
      this.profileHealth.set(profile.id, { state: "offline", observedAt });
    }
    void this.triggerScan().catch((error: unknown) => {
      process.stderr.write(`device initial scan failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }).finally(() => this.schedule());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async waitUntilReady(): Promise<void> {
    const activeScan = this.scanTask;
    if (activeScan) await activeScan;
  }

  connectorHealth(): Record<string, { state: "online" | "offline"; observedAt: string }> {
    return Object.fromEntries(this.profileHealth.entries());
  }

  async controlDeviceLayout(
    action: "status" | "enable" | "disable" | "recover",
    command?: { reason?: string; serverRevision?: number; actionId?: string }
  ): Promise<Record<string, unknown>> {
    return this.layoutControlExecutor.run(async () => {
      const argumentsList = [this.config.device.layoutControl.cliPath, action];
      if (action !== "status" && command?.reason) argumentsList.push("--reason", command.reason);
      if (action !== "status" && command?.serverRevision !== undefined) {
        argumentsList.push("--server-revision", String(command.serverRevision));
      }
      if (action !== "status" && command?.actionId) argumentsList.push("--action-id", command.actionId);
      const { stdout } = await execFileAsync(this.config.device.pythonPath, argumentsList, {
        cwd: this.config.runtimeDir,
        env: process.env,
        timeout: 60_000,
        maxBuffer: 512 * 1024,
        windowsHide: true
      });
      return parseLastJson(stdout);
    });
  }

  async sendReply(message: IncomingBridgeMessage, text: string, idempotencyKey: string): Promise<string> {
    const handle = JSON.parse(message.replyHandle) as { profileId?: string; conversationId?: string };
    const profile = this.requireProfile(handle.profileId);
    const conversation = this.requireConversation(profile, handle.conversationId);
    return this.runIdempotentOperation(idempotencyKey, async () => {
      const result = await this.runCli(profile, [
        "send", "--alias", conversation.alias, "--text", text, "--confirm"
      ]);
      requireVerifiedDispatchReceipt(result);
      return `${idempotencyKey}:${String(result.sendStatus ?? "sent")}`;
    });
  }

  async listConversationProfiles(): Promise<ConversationProfile[]> {
    const activeScan = this.scanTask;
    if (activeScan) await activeScan;
    const directory = join(this.config.runtimeDir, "device", "profiles");
    mkdirSync(directory, { recursive: true });
    const profiles: ConversationProfile[] = [];
    for (const profile of this.config.device.profiles) {
      const conversations = new Map<string, DeviceConversation>();
      for (const conversation of profile.conversations) {
        if (conversation.enabled) conversations.set(conversation.alias, conversation);
      }
      for (const [alias, conversation] of this.discoveredConversations.get(profile.id) ?? []) {
        if (conversation.enabled && !conversations.has(alias)) conversations.set(alias, conversation);
      }
      for (const conversation of conversations.values()) {
        if (!conversation.enabled) continue;
        const stem = `${safeName(profile.id)}-${safeName(conversation.alias)}`;
        const output = join(directory, `${stem}.json`);
        const avatarOutput = join(directory, `${stem}.avatar`);
        let native: NativeConversationProfile | undefined;
        if (!this.discoveryCoveredConversations.has(`${profile.id}:${conversation.alias}`)) {
          try {
            const result = await this.runCli(profile, [
              "profile", "--alias", conversation.alias,
              "--output", output,
              "--avatar-output", avatarOutput
            ]);
            if (result.ok === true && existsSync(output)) {
              const parsed = JSON.parse(readFileSync(output, "utf8")) as NativeConversationProfile;
              if (parsed.alias === conversation.alias) native = parsed;
            }
          } catch (error) {
            process.stderr.write(`device profile read failed: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
        const metadataKey = `${profile.id}:${conversation.alias}`;
        const runtimeMetadata = this.conversationMetadata.get(metadataKey) ?? {};
        const displayName = String(
          native?.displayName || this.conversationNames.get(metadataKey) || conversation.displayName
        ).trim().slice(0, 200);
        if (!displayName) continue;
        this.conversationNames.set(metadataKey, displayName);
        const metadata = resolveConversationProfileMetadata(native ?? {}, {
          ...runtimeMetadata,
          conversationType: runtimeMetadata.conversationType ?? conversation.conversationType,
          ...(runtimeMetadata.placement
            ? {}
            : conversation.placementOverride ? { placement: conversation.placementOverride } : {})
        });
        const nativeAvatar = native?.avatar;
        let avatar = nativeAvatar?.path && existsSync(nativeAvatar.path) && nativeAvatar.mimeType && nativeAvatar.sha256 &&
          Number(nativeAvatar.sizeBytes) > 0 && Number(nativeAvatar.sizeBytes) <= MAX_PROFILE_AVATAR_BYTES
          ? {
            stagedPath: nativeAvatar.path,
            mimeType: nativeAvatar.mimeType,
            sizeBytes: Number(nativeAvatar.sizeBytes),
            sha256: nativeAvatar.sha256
          }
          : undefined;
        if (!avatar) {
          const discoveredAvatar = decodeImage(runtimeMetadata.avatarBase64);
          if (discoveredAvatar) {
            const stagedPath = join(directory, `${stem}.discovered.${discoveredAvatar.extension}`);
            writeFileSync(stagedPath, discoveredAvatar.bytes);
            avatar = {
              stagedPath,
              mimeType: discoveredAvatar.mimeType,
              sizeBytes: discoveredAvatar.bytes.byteLength,
              sha256: createHash("sha256").update(discoveredAvatar.bytes).digest("hex")
            };
          }
        }
        profiles.push({
          profileId: profile.id,
          conversationId: conversation.alias,
          displayName,
          ...metadata,
          ...(runtimeMetadata.pinned !== undefined ? { pinned: runtimeMetadata.pinned } : {}),
          ...(runtimeMetadata.unreadCount !== undefined ? { unreadCount: runtimeMetadata.unreadCount } : {}),
          ...(runtimeMetadata.unreadObservedAt ? { unreadObservedAt: runtimeMetadata.unreadObservedAt } : {}),
          ...(runtimeMetadata.lastMessagePreview ? { lastMessagePreview: runtimeMetadata.lastMessagePreview } : {}),
          ...(runtimeMetadata.lastMessageAt ? { lastMessageAt: runtimeMetadata.lastMessageAt } : {}),
          ...(avatar ? { avatar } : {})
        });
      }
    }
    return profiles;
  }

  async listConversationFiles(conversationId: string): Promise<ConversationFileInventory> {
    const { profile, conversation } = this.findConversation(conversationId);
    const output = join(
      this.config.runtimeDir,
      "device",
      "snapshots",
      `${safeName(profile.id)}-${safeName(conversation.alias)}-files.json`
    );
    const result = await this.runCli(profile, ["files", "--alias", conversation.alias, "--output", output]);
    if (result.ok !== true) throw new Error(`device_file_list_failed:${String(result.error ?? "unknown")}`);
    const payload = JSON.parse(readFileSync(output, "utf8")) as {
      files?: ConversationFileInventory["files"];
      folders?: ConversationFileInventory["folders"];
    };
    return { conversationId, files: payload.files ?? [], folders: payload.folders ?? [] };
  }

  async downloadConversationFile(
    conversationId: string,
    fileAlias: string,
    outputDir: string
  ): Promise<DownloadedConversationFile> {
    const { profile, conversation } = this.findConversation(conversationId);
    const result = await this.runCli(profile, [
      "download", "--alias", conversation.alias,
      "--file-alias", fileAlias,
      "--output-dir", outputDir
    ]);
    if (result.ok !== true) throw new Error(`device_file_download_failed:${String(result.error ?? "unknown")}`);
    return {
      conversationId,
      fileAlias,
      fileName: String(result.fileName ?? fileAlias),
      path: String(result.output),
      sizeBytes: Number(result.size ?? 0),
      sha256: String(result.sha256 ?? "")
    };
  }

  async sendConversationFile(
    conversationId: string,
    sourcePath: string,
    idempotencyKey: string,
    preferredProfileId?: string
  ): Promise<SentConversationFile> {
    const { profile, conversation } = this.findConversation(conversationId, preferredProfileId);
    this.assertCanSendConversationFile(conversationId, preferredProfileId);
    const absolutePath = resolve(sourcePath);
    const content = readFileSync(absolutePath);
    return this.runIdempotentOperation(idempotencyKey, async () => {
      const result = await this.runCli(profile, [
        "send-file", "--alias", conversation.alias,
        "--path", absolutePath,
        "--confirm"
      ]);
      requireVerifiedDispatchReceipt(result);
      const sourceSize = Number(result.sourceSize ?? -1);
      if (sourceSize !== content.byteLength) throw new Error("device_file_send_size_mismatch");
      return {
        conversationId,
        fileName: basename(absolutePath),
        sizeBytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
        adapterReceipt: `${idempotencyKey}:${String(result.messageAlias ?? "sent")}`
      };
    });
  }

  assertCanSendConversationFile(conversationId: string, preferredProfileId?: string): void {
    const { profile, conversation } = this.findConversation(conversationId, preferredProfileId);
    if (profile.driver !== "element") throw new Error("device_file_send_not_supported_for_profile");
    if (conversation.conversationType !== "group") {
      throw new Error("device_file_send_not_supported_for_conversation");
    }
  }

  private async runIdempotentOperation<T>(idempotencyKey: string, operation: () => Promise<T>): Promise<T> {
    const directory = join(this.config.runtimeDir, "device", "idempotency");
    mkdirSync(directory, { recursive: true });
    this.pruneCompletedIdempotencyRecords(directory);
    const digest = createHash("sha256").update(idempotencyKey).digest("hex");
    const path = join(directory, `${digest}.json`);
    if (existsSync(path)) {
      let record: { state?: string; result?: T };
      try {
        record = JSON.parse(readFileSync(path, "utf8")) as { state?: string; result?: T };
      } catch {
        throw new Error("device_idempotency_ledger_corrupt");
      }
      if (record.state === "completed" && record.result !== undefined) return record.result;
      throw new Error("device_send_outcome_uncertain");
    }
    const started = `${path}.tmp-${process.pid}`;
    const startedAt = new Date().toISOString();
    writeFileSync(started, JSON.stringify({
      version: 1,
      state: "started",
      keyHash: digest,
      startedAt
    }), "utf8");
    renameSync(started, path);
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("device_operation_not_dispatched:")) {
        try { unlinkSync(path); } catch { /* A missing retry marker is harmless here. */ }
        throw error;
      }
      if (message.startsWith("device_send_outcome_uncertain")) throw error;
      throw new Error(`device_send_outcome_uncertain:${message}`);
    }
    const completed = `${path}.tmp-${process.pid}`;
    try {
      writeFileSync(completed, JSON.stringify({
        version: 1,
        state: "completed",
        keyHash: digest,
        startedAt,
        completedAt: new Date().toISOString(),
        result
      }), "utf8");
      renameSync(completed, path);
    } catch (error) {
      // Native work has already returned. Keep the original `started` marker so
      // a later invocation is quarantined instead of repeating the operation.
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`device_send_outcome_uncertain:device_idempotency_completion_failed:${detail}`);
    }
    return result;
  }

  private pruneCompletedIdempotencyRecords(directory: string): void {
    const current = Date.now();
    if (current - this.lastIdempotencyPruneAt < IDEMPOTENCY_PRUNE_INTERVAL_MS) return;
    this.lastIdempotencyPruneAt = current;
    const retained: Array<{ path: string; completedAt: number }> = [];
    for (const name of readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(directory, name);
      try {
        const record = JSON.parse(readFileSync(path, "utf8")) as { state?: string; completedAt?: string };
        if (record.state !== "completed") continue;
        const completedAt = Date.parse(record.completedAt || "");
        if (Number.isFinite(completedAt) && current - completedAt > IDEMPOTENCY_COMPLETED_RETENTION_MS) {
          unlinkSync(path);
        } else {
          retained.push({ path, completedAt: Number.isFinite(completedAt) ? completedAt : current });
        }
      } catch {
        // Corrupt and started markers remain fail-closed: their native send outcome
        // may be uncertain, so automatic pruning must never make them replayable.
      }
    }
    if (retained.length <= IDEMPOTENCY_COMPLETED_LIMIT) return;
    retained.sort((left, right) => left.completedAt - right.completedAt);
    for (const record of retained.slice(0, retained.length - IDEMPOTENCY_COMPLETED_LIMIT)) {
      try { unlinkSync(record.path); } catch { /* Best-effort capacity bound. */ }
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.triggerScan().catch((error: unknown) => {
        process.stderr.write(`device scan failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }).finally(() => this.schedule());
    }, this.config.device.pollIntervalMs);
  }

  private triggerScan(): Promise<void> {
    if (this.scanTask) return this.scanTask;
    const task = this.scan().finally(() => {
      if (this.scanTask === task) this.scanTask = undefined;
    });
    this.scanTask = task;
    return task;
  }

  private async scan(): Promise<void> {
    if (this.scanning || this.stopped || !this.onMessage) return;
    this.scanning = true;
    try {
      for (const profile of this.config.device.profiles) {
        let profileSucceeded = false;
        const discoveryEnabled = profile.discoverDirectConversations || profile.discoverGroupConversations;
        let discoverySucceeded = !discoveryEnabled;
        if (discoveryEnabled) {
          try {
            await this.scanDiscoveredConversations(profile);
            discoverySucceeded = true;
            profileSucceeded = true;
            for (const conversation of profile.conversations) {
              if (!conversation.enabled ||
                  this.discoveryCoveredConversations.has(`${profile.id}:${conversation.alias}`)) continue;
              try {
                await this.scanConversation(profile, conversation);
                profileSucceeded = true;
              } catch (fallbackError) {
                process.stderr.write(`device conversation configured scan failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\n`);
              }
            }
          } catch (error) {
            process.stderr.write(`device conversation discovery failed: ${error instanceof Error ? error.message : String(error)}\n`);
            for (const conversation of profile.conversations) {
              if (!conversation.enabled) continue;
              try {
                await this.scanConversation(profile, conversation);
                profileSucceeded = true;
              } catch (fallbackError) {
                process.stderr.write(`device conversation fallback scan failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\n`);
              }
            }
          }
        } else {
          for (const conversation of profile.conversations) {
            if (!conversation.enabled) continue;
            try {
              await this.scanConversation(profile, conversation);
              profileSucceeded = true;
            } catch (error) {
              process.stderr.write(`device conversation scan failed: ${error instanceof Error ? error.message : String(error)}\n`);
            }
          }
        }
        this.profileHealth.set(profile.id, {
          // A discovery-enabled profile is not command-ready when only its
          // configured fallback conversations were readable. Cloud commands
          // may target a dynamically discovered conversation, so leasing while
          // the directory is stale would turn a temporary outage into a
          // permanent device_conversation_not_found failure.
          state: profileSucceeded && discoverySucceeded ? "online" : "offline",
          observedAt: new Date().toISOString()
        });
      }
    } finally {
      this.scanning = false;
    }
  }

  private rememberConversationMetadata(
    profileId: string,
    conversationId: string,
    metadata: ConversationRuntimeMetadata
  ): void {
    const key = `${profileId}:${conversationId}`;
    const current = this.conversationMetadata.get(key) ?? {};
    const rememberedPlacement = metadata.placement === "unknown" && current.placement && current.placement !== "unknown"
      ? current.placement : metadata.placement;
    this.conversationMetadata.set(key, {
      ...current,
      ...(metadata.channelLabel ? { channelLabel: metadata.channelLabel } : {}),
      ...(metadata.conversationType ? { conversationType: metadata.conversationType } : {}),
      ...(rememberedPlacement ? { placement: rememberedPlacement } : {}),
      ...(metadata.avatarBase64 ? { avatarBase64: metadata.avatarBase64 } : {}),
      ...(metadata.pinned !== undefined ? { pinned: metadata.pinned } : {}),
      ...(metadata.unreadCount !== undefined ? { unreadCount: Math.max(0, Math.floor(metadata.unreadCount)) } : {}),
      ...(metadata.unreadObservedAt ? { unreadObservedAt: metadata.unreadObservedAt } : {}),
      ...(metadata.lastMessagePreview ? { lastMessagePreview: metadata.lastMessagePreview } : {}),
      ...(metadata.lastMessageAt ? { lastMessageAt: metadata.lastMessageAt } : {})
    });
  }

  private discoveryHistoryContinuationInput(profile: DeviceProfile): string {
    const cursorDirectory = join(this.config.runtimeDir, "device", "cursors");
    const snapshotDirectory = join(this.config.runtimeDir, "device", "snapshots");
    mkdirSync(cursorDirectory, { recursive: true });
    mkdirSync(snapshotDirectory, { recursive: true });
    const desiredRevision = profile.backfillRevision ?? profile.historyRevision;
    const expectedMode = profile.driver === "element" ? "kernel-msg-id" : "local-id";
    const prefix = `${safeName(profile.id)}-`;
    const cursors: Record<string, HistoryContinuation> = {};
    const load = (name: string, suffix: string): void => {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) return;
      const alias = name.slice(prefix.length, -suffix.length);
      if (!/^conversation-[0-9a-f]{8}$/.test(alias) || cursors[alias]) return;
      try {
        const value = JSON.parse(readFileSync(join(cursorDirectory, name), "utf8")) as DiscoveredRecordCursor;
        if (Number(value.historyContinuationRevision) !== desiredRevision) return;
        const continuation = normalizeHistoryContinuation(value.historyContinuation);
        if (continuation?.mode === expectedMode) cursors[alias] = continuation;
      } catch {
        // A malformed or partially written cursor is ignored; discovery restarts from the latest page.
      }
    };
    const names = readdirSync(cursorDirectory).sort();
    for (const name of names) {
      if (!name.endsWith(".history.json")) load(name, ".json");
    }
    for (const name of names) load(name, ".json.history.json");
    const output = join(snapshotDirectory, `${safeName(profile.id)}-history-continuations.json`);
    const temporary = `${output}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify({ version: 1, cursors }), "utf8");
    renameSync(temporary, output);
    return output;
  }

  private async runDiscoveryCli(profile: DeviceProfile, output: string): Promise<Record<string, unknown>> {
    const historyCursorInput = this.discoveryHistoryContinuationInput(profile);
    const common = [
      "discover-direct-messages",
      "--output", output,
      "--history-cursor-input", historyCursorInput,
      "--conversation-limit", String(profile.discoveryConversationLimit),
      "--active-window-seconds", String(profile.discoveryActiveWindowSeconds),
      ...(profile.discoverGroupConversations ? ["--include-groups"] : [])
    ];
    const mode = this.discoveryCliModes.get(profile.id) ?? "modern";
    const argsFor = (selectedMode: "modern" | "message-20" | "legacy"): string[] => [
      ...common,
      "--message-limit", String(selectedMode === "modern"
        ? profile.discoveryMessageLimit
        : Math.min(profile.discoveryMessageLimit, 20)),
      ...(selectedMode === "legacy"
        ? []
        : ["--history-window-seconds", String(profile.historyWindowSeconds)])
    ];
    if (mode !== "modern") return this.runCli(profile, argsFor(mode), 360_000);
    try {
      return await this.runCli(profile, argsFor("modern"), 360_000);
    } catch (error) {
      if (!isLegacyDiscoveryArgumentError(error)) throw error;
      try {
        const result = await this.runCli(profile, argsFor("message-20"), 360_000);
        this.discoveryCliModes.set(profile.id, "message-20");
        return result;
      } catch (fallbackError) {
        if (!isLegacyDiscoveryArgumentError(fallbackError)) throw fallbackError;
        const result = await this.runCli(profile, argsFor("legacy"), 360_000);
        this.discoveryCliModes.set(profile.id, "legacy");
        return result;
      }
    }
  }

  private effectiveDiscoveryMessageLimit(profile: DeviceProfile): number {
    const mode = this.discoveryCliModes.get(profile.id) ?? "modern";
    return mode === "modern" ? profile.discoveryMessageLimit : Math.min(profile.discoveryMessageLimit, 20);
  }

  private async scanDiscoveredConversations(profile: DeviceProfile): Promise<void> {
    const output = join(
      this.config.runtimeDir,
      "device",
      "snapshots",
      `${safeName(profile.id)}-discovered-conversations.json`
    );
    const result = await this.runDiscoveryCli(profile, output);
    if (result.ok !== true) {
      throw new Error(`device_conversation_discovery_failed:${String(result.error ?? "unknown")}`);
    }
    const parsedPayload = JSON.parse(readFileSync(output, "utf8")) as unknown;
    const payload: NativeDiscoveryPayload = Array.isArray(parsedPayload)
      ? { conversations: parsedPayload as NativeDiscoveredConversation[] }
      : parsedPayload as NativeDiscoveryPayload;
    for (const key of this.discoveryCoveredConversations) {
      if (key.startsWith(`${profile.id}:`)) this.discoveryCoveredConversations.delete(key);
    }
    const configured = new Map(
      profile.conversations.filter((item) => item.enabled).map((item) => [item.alias, item] as const)
    );
    const disabled = new Set(profile.conversations.filter((item) => !item.enabled).map((item) => item.alias));
    let discovered = this.discoveredConversations.get(profile.id);
    if (!discovered) {
      discovered = new Map<string, DeviceConversation>();
      this.discoveredConversations.set(profile.id, discovered);
    }
    discovered.clear();
    for (const item of payload.conversations ?? []) {
      const alias = String(item.alias || "");
      const displayName = String(item.displayName || alias).trim().slice(0, 200);
      if (!/^conversation-[0-9a-f]{8}$/.test(alias) || !displayName || disabled.has(alias)) continue;
      const configuredConversation = configured.get(alias);
      const nativeConversationType = optionalConversationType(item.conversationType) ??
        configuredConversation?.conversationType ?? "direct";
      if (!configuredConversation) {
        if (nativeConversationType === "group" && !profile.discoverGroupConversations) continue;
        if (nativeConversationType === "direct" && !profile.discoverDirectConversations) continue;
      }
      const conversation: DeviceConversation = configuredConversation ?? {
        alias,
        displayName,
        assurance: "verified",
        conversationType: nativeConversationType,
        groupDelivery: nativeConversationType === "group" ? "mentions_and_requests" : "all",
        mentionTerms: [],
        contextBefore: nativeConversationType === "group" ? 20 : 0,
        enabled: true
      };
      this.discoveryCoveredConversations.add(`${profile.id}:${alias}`);
      if (!configuredConversation) discovered.set(alias, conversation);
      this.conversationNames.set(`${profile.id}:${alias}`, displayName);
      const conversationPlacement = conversation.placementOverride ?? placement(item.placement?.bucket);
      const channelLabel = optionalChannelLabel(item.channelLabel ?? payload.channelLabel);
      this.rememberConversationMetadata(profile.id, alias, {
        ...(channelLabel ? { channelLabel } : {}),
        conversationType: nativeConversationType,
        placement: conversationPlacement,
        ...(item.pinned !== undefined ? { pinned: item.pinned === true } : {}),
        ...(Number.isFinite(Number(item.unreadCount))
          ? { unreadCount: Math.max(0, Math.floor(Number(item.unreadCount))),
            unreadObservedAt: typeof item.unreadObservedAt === "string" &&
              Number.isFinite(Date.parse(item.unreadObservedAt))
              ? new Date(item.unreadObservedAt).toISOString()
              : new Date().toISOString() }
          : {}),
        ...(typeof item.lastMessagePreview === "string" && item.lastMessagePreview.trim()
          ? { lastMessagePreview: item.lastMessagePreview.trim().slice(0, 500) }
          : {}),
        ...(Number(item.lastMessageAt) > 0
          ? { lastMessageAt: new Date(Number(item.lastMessageAt) * 1000).toISOString() }
          : {}),
        ...(typeof item.avatarBase64 === "string" &&
            item.avatarBase64.replace(/\s/g, "").length <= MAX_PROFILE_AVATAR_BASE64_LENGTH
          ? { avatarBase64: item.avatarBase64 }
          : {})
      });
      const orderedRecords = (item.records ?? [])
        .map((record) => ({
          ...this.normalizeContextRecord(record),
          ...(typeof item.unreadObservedAt === "string" && Number.isFinite(Date.parse(item.unreadObservedAt))
            ? { observedAt: new Date(item.unreadObservedAt).toISOString() }
            : {})
        }))
        .sort((left, right) => Number(left.msgTime || 0) - Number(right.msgTime || 0));
      const recordsWithContext = orderedRecords.map((record, index) => ({
        ...record,
        ...(conversation.conversationType === "group"
          ? { contextRecords: orderedRecords.slice(Math.max(0, index - conversation.contextBefore), index) }
          : {})
      }));
      const batch = this.prepareDiscoveredRecords(
        profile,
        conversation,
        recordsWithContext.filter((record) => record.isSelf !== true),
        conversationPlacement,
        !item.messageReadError && (item.history
          ? item.history.complete === true && item.history.truncated !== true
          : Number(item.messageCount ?? orderedRecords.length) < this.effectiveDiscoveryMessageLimit(profile)),
        !item.messageReadError,
        normalizeHistoryContinuation(item.history?.continuation)
      );
      for (const record of batch.records) {
        const message = this.normalizeRecord(profile, conversation, record, conversationPlacement);
        if (message) await this.onMessage?.(message);
      }
      batch.commit();
    }
  }

  private normalizeContextRecord(record: NativeRecord): NativeRecord {
    if (record.elements?.length) return record;
    const content = String(record.text || "");
    const messageType = Number(record.messageType || 0);
    const kindByType: Record<number, string> = {
      1: "text", 3: "picture", 34: "voice", 43: "video", 47: "market-face", 49: "file"
    };
    return {
      ...record,
      elements: [{
        elementType: messageType,
        kind: kindByType[messageType] || "opaque",
        text: { content }
      }]
    };
  }

  private prepareDiscoveredRecords(
    profile: DeviceProfile,
    conversation: DeviceConversation,
    records: NativeRecord[],
    conversationPlacement: ConversationPlacement,
    historyComplete = true,
    advanceLiveCursor = true,
    historyContinuation?: HistoryContinuation
  ): { records: NativeRecord[]; commit: () => void } {
    const cursorPath = join(
      this.config.runtimeDir,
      "device",
      "cursors",
      `${safeName(profile.id)}-${safeName(conversation.alias)}.json`
    );
    const historyPath = `${cursorPath}.history.json`;
    const cursorExisted = existsSync(cursorPath);
    const cursor = cursorExisted
      ? JSON.parse(readFileSync(cursorPath, "utf8")) as DiscoveredRecordCursor
      : {};
    if (existsSync(historyPath)) {
      const history = JSON.parse(readFileSync(historyPath, "utf8")) as DiscoveredRecordCursor;
      const revision = Math.max(
        Number(cursor.historyRevision || 0),
        Number(cursor.backfillRevision || 0),
        Number(history.historyRevision || 0),
        Number(history.backfillRevision || 0)
      );
      cursor.historyRevision = revision;
      cursor.backfillRevision = revision;
      cursor.cardParserRevision = Math.max(
        Number(cursor.cardParserRevision || 0),
        Number(history.cardParserRevision || 0)
      );
      cursor.historyIncomplete = cursor.historyIncomplete === true || history.historyIncomplete === true;
      if (!cursor.historyContinuation) {
        const storedContinuation = normalizeHistoryContinuation(history.historyContinuation);
        if (storedContinuation) {
          cursor.historyContinuation = storedContinuation;
          cursor.historyContinuationRevision = Number(history.historyContinuationRevision || 0);
        }
      }
    }
    const historyRevision = profile.backfillRevision ?? profile.historyRevision;
    const selection = selectDiscoveredRecords(records, cursor, {
      cursorExisted,
      catchupSeconds: profile.discoveryCatchupSeconds,
      historyWindowSeconds: profile.historyWindowSeconds,
      historyRevision,
      allowHistoryBackfill: conversation.conversationType === "group" && conversationPlacement === "normal",
      historyComplete,
      advanceLiveCursor,
      ...(historyContinuation ? { historyContinuation } : {})
    });
    return {
      records: selection.records,
      commit: () => {
        const historyCompletenessChanged = selection.nextCursor.historyIncomplete !== cursor.historyIncomplete;
        const historyContinuationChanged =
          selection.nextCursor.historyContinuationRevision !== cursor.historyContinuationRevision ||
          JSON.stringify(selection.nextCursor.historyContinuation ?? null) !==
            JSON.stringify(normalizeHistoryContinuation(cursor.historyContinuation) ?? null);
        const shouldPersist = records.length > 0 || selection.historyRevisionApplied ||
          historyCompletenessChanged || historyContinuationChanged;
        if (shouldPersist) {
          const mainCursor = {
            ...selection.nextCursor,
            historyRevision: Math.max(Number(cursor.historyRevision || 0), Number(cursor.backfillRevision || 0)),
            backfillRevision: Math.max(Number(cursor.historyRevision || 0), Number(cursor.backfillRevision || 0))
          };
          const temporary = `${cursorPath}.tmp-${process.pid}`;
          writeFileSync(temporary, JSON.stringify(mainCursor), "utf8");
          renameSync(temporary, cursorPath);
        }
        if (shouldPersist) {
          const temporary = `${historyPath}.tmp-${process.pid}`;
          writeFileSync(temporary, JSON.stringify({
            version: 1,
            cardParserRevision: selection.nextCursor.cardParserRevision,
            historyRevision: selection.nextCursor.historyRevision,
            backfillRevision: selection.nextCursor.backfillRevision,
            historyIncomplete: selection.nextCursor.historyIncomplete,
            ...(selection.nextCursor.historyContinuation ? {
              historyContinuation: selection.nextCursor.historyContinuation,
              historyContinuationRevision: selection.nextCursor.historyContinuationRevision
            } : {}),
            appliedAt: new Date().toISOString()
          }), "utf8");
          renameSync(temporary, historyPath);
        }
      }
    };
  }

  private async scanConversation(profile: DeviceProfile, conversation: DeviceConversation): Promise<void> {
    const stem = `${safeName(profile.id)}-${safeName(conversation.alias)}`;
    const output = join(this.config.runtimeDir, "device", "snapshots", `${stem}.json`);
    const cursor = join(this.config.runtimeDir, "device", "cursors", `${stem}.json`);
    const cursorExisted = existsSync(cursor);
    const candidateCursor = `${cursor}.candidate-${process.pid}`;
    try {
      if (existsSync(candidateCursor)) unlinkSync(candidateCursor);
      if (cursorExisted) copyFileSync(cursor, candidateCursor);
      const result = await this.runCli(profile, [
        "messages", "--alias", conversation.alias,
        "--limit", String(this.config.device.messageLimit),
        "--output", output,
        "--cursor", candidateCursor,
        "--context-before", String(conversation.conversationType === "group" ? conversation.contextBefore : 0)
      ]);
      if (result.ok !== true) throw new Error(`device_message_read_failed:${String(result.error ?? "unknown")}`);
      const payload = JSON.parse(readFileSync(output, "utf8")) as NativeMessagePayload;
      const conversationPlacement = conversation.placementOverride ?? placement(payload.conversationPlacement?.bucket);
      this.rememberConversationMetadata(profile.id, conversation.alias, {
        conversationType: conversation.conversationType,
        placement: conversationPlacement
      });
      if (cursorExisted || this.config.device.ingestHistory) {
        for (const record of payload.records ?? []) {
          const message = this.normalizeRecord(profile, conversation, record, conversationPlacement);
          if (message) await this.onMessage?.(message);
        }
      }
      // bridge_cli advances only the candidate cursor. Publish it after every
      // normalized message has been durably accepted by the spool callback.
      if (existsSync(candidateCursor)) renameSync(candidateCursor, cursor);
    } finally {
      if (existsSync(candidateCursor)) unlinkSync(candidateCursor);
    }
  }

  private normalizeRecord(
    profile: DeviceProfile,
    conversation: DeviceConversation,
    record: NativeRecord,
    conversationPlacement: "normal" | "folded" | "message_box" | "unknown"
  ): IncomingBridgeMessage | null {
    if (!record.messageAlias) return null;
    const sender = recordSender(record);
    const messageText = recordText(record);
    const policy = this.config.groups.find((item) => item.conversationId === conversation.alias && item.enabled);
    const requiredPrefix = policy?.requiredPrefix || "";
    const historyBackfill = record.historyBackfill === true &&
      conversation.conversationType === "group" && conversationPlacement === "normal";
    const { trigger, mentioned } = historyBackfill
      ? { trigger: "background" as const, mentioned: false }
      : classifyMessageTrigger({
        conversationType: conversation.conversationType,
        text: messageText,
        textElements: (record.elements ?? []).map((element) => ({
          content: element.text?.content ?? "",
          atType: element.text?.atType ?? 0,
          atTargetAlias: element.text?.atTargetAlias ?? "",
        })),
        mentionTerms: conversation.mentionTerms,
        requiredPrefix,
      });
    const backupOnly = historyBackfill ||
      (conversation.conversationType === "group" && trigger === "background");
    const outgoingText = backupOnly ? recordPlainText(record).trim() : messageText;
    if (backupOnly && !outgoingText) return null;
    const context = !historyBackfill && (trigger === "mention" || trigger === "explicit_request")
      ? (record.contextRecords ?? []).slice(-conversation.contextBefore).map((item) => {
        const contextSender = recordSender(item);
        return {
          messageId: item.messageAlias || `context-${item.msgTime || 0}`,
          senderId: contextSender.id,
          senderName: contextSender.name,
          receivedAt: new Date(Math.max(0, Number(item.msgTime ?? 0)) * 1000).toISOString(),
          text: recordText(item).slice(0, 2000)
        };
      })
      : [];
    const raw = JSON.stringify(record);
    return {
      id: `${profile.id}:${record.messageAlias}`,
      conversation: {
        id: conversation.alias,
        displayName: this.conversationNames.get(`${profile.id}:${conversation.alias}`) || conversation.displayName,
        assurance: conversation.assurance
      },
      sender: { id: sender.id, displayName: sender.name, assurance: "verified" },
      receivedAt: new Date(Math.max(0, Number(record.msgTime ?? 0)) * 1000).toISOString(),
      ...(record.observedAt && Number.isFinite(Date.parse(record.observedAt))
        ? { observedAt: new Date(record.observedAt).toISOString() }
        : {}),
      text: outgoingText,
      attachments: [],
      conversationType: conversation.conversationType,
      trigger,
      mentioned,
      placement: conversationPlacement,
      backupOnly,
      context,
      replyHandle: JSON.stringify({ profileId: profile.id, conversationId: conversation.alias }),
      rawEventDigest: createHash("sha256").update(raw).digest("hex")
    };
  }

  private async runCli(
    profile: DeviceProfile,
    args: string[],
    timeoutMs = 150_000
  ): Promise<Record<string, unknown>> {
    return this.cliExecutor.run(async () => {
      const targetBundleId = process.env[profile.targetBundleEnv];
      const navigationTemplate = process.env[profile.navigationTemplateEnv];
      if (!targetBundleId) throw new Error(`missing_profile_environment:${profile.targetBundleEnv}`);
      const { stdout } = await execFileAsync(
        this.config.device.pythonPath,
        [this.config.device.cliPath, ...args],
        {
          cwd: this.config.runtimeDir,
          env: {
            ...process.env,
            BRIDGE_DRIVER: profile.driver,
            BRIDGE_TARGET_BUNDLE_ID: targetBundleId,
            ...(navigationTemplate ? { BRIDGE_NAVIGATE_URL_TEMPLATE: navigationTemplate } : {})
          },
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true
        }
      );
      return parseLastJson(stdout);
    });
  }

  private validateProfileEnvironment(profile: DeviceProfile): void {
    if (!process.env[profile.targetBundleEnv]) {
      throw new Error(`missing_profile_environment:${profile.targetBundleEnv}`);
    }
  }

  private requireProfile(profileId: string | undefined): DeviceProfile {
    const profile = this.config.device.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error("device_profile_not_found");
    return profile;
  }

  private requireConversation(profile: DeviceProfile, conversationId: string | undefined): DeviceConversation {
    const conversation = profile.conversations.find((item) => item.alias === conversationId && item.enabled)
      ?? this.discoveredConversations.get(profile.id)?.get(String(conversationId || ""));
    if (!conversation) throw new Error("device_conversation_not_found");
    return conversation;
  }

  private findConversation(
    conversationId: string,
    preferredProfileId?: string
  ): { profile: DeviceProfile; conversation: DeviceConversation } {
    if (preferredProfileId) {
      const profile = this.config.device.profiles.find((item) => item.id === preferredProfileId);
      if (!profile) throw new Error("device_profile_not_found");
      const conversation = profile.conversations.find((item) => item.alias === conversationId && item.enabled)
        ?? this.discoveredConversations.get(profile.id)?.get(conversationId);
      if (!conversation) throw new Error("device_conversation_not_found");
      return { profile, conversation };
    }
    for (const profile of this.config.device.profiles) {
      const conversation = profile.conversations.find((item) => item.alias === conversationId && item.enabled)
        ?? this.discoveredConversations.get(profile.id)?.get(conversationId);
      if (conversation) return { profile, conversation };
    }
    throw new Error("device_conversation_not_found");
  }
}
