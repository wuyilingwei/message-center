export type PresenceState = "active" | "quiescent" | "away_unlocked" | "locked" | "unknown";

export type IdentityAssurance = "verified" | "display_only";

export type MessageState = "pending" | "leased" | "completed" | "dead_letter";

export type TrustTier = "trusted" | "untrusted" | "rejected";

export type ConversationType = "direct" | "group";

export type ConversationPlacement = "normal" | "folded" | "message_box" | "unknown";

export type MessageTrigger = "direct" | "mention" | "explicit_request" | "background";

export interface BridgeIdentity {
  id: string;
  displayName: string;
  assurance: IdentityAssurance;
}

export interface IncomingAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
  stagedPath: string;
}

export interface IncomingBridgeMessage {
  id: string;
  conversation: BridgeIdentity;
  sender: BridgeIdentity;
  receivedAt: string;
  /** Device-side observation time; separates messages seen before/after a native unread snapshot. */
  observedAt?: string;
  text: string;
  attachments: IncomingAttachment[];
  conversationType?: ConversationType;
  trigger?: MessageTrigger;
  mentioned?: boolean;
  placement?: ConversationPlacement;
  backupOnly?: boolean;
  context?: Array<{
    messageId: string;
    senderId: string;
    senderName: string;
    receivedAt: string;
    text: string;
  }>;
  replyHandle: string;
  rawEventDigest?: string;
}

export interface MessageScope {
  trustTier: TrustTier;
  projectIds: string[];
  allowedActions: string[];
  replyPolicy: "none" | "ack" | "informational" | "scoped_agent";
  reason: string;
}

export interface ClaimedAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
}

export interface ClaimedMessage {
  id: string;
  leaseToken: string;
  leaseExpiresAt: string;
  conversation: Omit<BridgeIdentity, "assurance"> & { assurance: IdentityAssurance };
  sender: Omit<BridgeIdentity, "assurance"> & { assurance: IdentityAssurance };
  receivedAt: string;
  text: string;
  attachments: ClaimedAttachment[];
  scope: MessageScope;
}

export interface ReplyResult {
  replyId: string;
  status: "dry_run" | "queued" | "sent" | "failed";
  adapterReceipt?: string;
}

export interface ConversationFile {
  fileAlias: string;
  fileName: string;
  fileSize: number;
  folderAlias?: string | null;
  uploaderAlias?: string | null;
  uploaderName?: string;
  uploadTime?: number;
  expireTime?: number;
}

export interface ConversationFileInventory {
  conversationId: string;
  files: ConversationFile[];
  folders: Array<{
    folderAlias: string | null;
    folderName: string;
    parentFolderAlias?: string | null;
    fileCount?: number;
  }>;
}

export interface DownloadedConversationFile {
  conversationId: string;
  fileAlias: string;
  fileName: string;
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface SentConversationFile {
  conversationId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  adapterReceipt: string;
}

export interface ConversationProfile {
  profileId: string;
  conversationId: string;
  displayName: string;
  channelLabel?: string;
  conversationType?: ConversationType;
  placement?: ConversationPlacement;
  pinned?: boolean;
  unreadCount?: number;
  unreadObservedAt?: string;
  lastMessagePreview?: string;
  lastMessageAt?: string;
  avatar?: {
    stagedPath: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  };
}

export interface PresenceSnapshot {
  state: PresenceState;
  idleSeconds: number | null;
  sessionLocked: boolean | null;
  observedAt: string;
  source: "windows" | "fallback";
}

export interface GroupPolicy {
  conversationId: string;
  enabled: boolean;
  requireVerifiedIdentity: boolean;
  allowedSenderIds: string[];
  requiredPrefix: string;
  projectIds: string[];
  allowedActions: string[];
  replyPolicy: MessageScope["replyPolicy"];
}

export interface BridgeAdapter {
  readonly name: string;
  readonly canSendWhileLocked: boolean;
  start(onMessage: (message: IncomingBridgeMessage) => Promise<void>): Promise<void>;
  waitUntilReady?(): Promise<void>;
  stop(): Promise<void>;
  connectorHealth?(): Record<string, { state: "online" | "offline"; observedAt: string }>;
  controlDeviceLayout?(
    action: "status" | "enable" | "disable" | "recover",
    command?: { reason?: string; serverRevision?: number; actionId?: string }
  ): Promise<Record<string, unknown>>;
  sendReply(message: IncomingBridgeMessage, text: string, idempotencyKey: string): Promise<string>;
  assertCanSendConversationFile?(conversationId: string, preferredProfileId?: string): void | Promise<void>;
  listConversationProfiles?(): Promise<ConversationProfile[]>;
  listConversationFiles?(conversationId: string): Promise<ConversationFileInventory>;
  downloadConversationFile?(
    conversationId: string,
    fileAlias: string,
    outputDir: string
  ): Promise<DownloadedConversationFile>;
  sendConversationFile?(
    conversationId: string,
    sourcePath: string,
    idempotencyKey: string,
    preferredProfileId?: string
  ): Promise<SentConversationFile>;
}
