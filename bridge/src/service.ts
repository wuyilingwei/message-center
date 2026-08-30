import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { downloadAttachment, type DownloadedAttachment } from "./attachments.js";
import { evaluateMessagePolicy } from "./policy.js";
import { PresenceService } from "./presence.js";
import { MessageStore } from "./store.js";
import type {
  ClaimedMessage,
  ConversationFileInventory,
  DownloadedConversationFile,
  PresenceSnapshot,
  BridgeAdapter,
  ReplyResult
} from "./types.js";

export class BridgeService {
  readonly store: MessageStore;
  readonly presence: PresenceService;
  private queueChangedListeners = new Set<() => void>();

  constructor(
    readonly config: AppConfig,
    readonly adapter: BridgeAdapter
  ) {
    mkdirSync(config.runtimeDir, { recursive: true });
    this.store = new MessageStore(join(config.runtimeDir, "queue.sqlite"));
    this.presence = new PresenceService(config);
  }

  async start(): Promise<void> {
    await this.adapter.start(async (message) => {
      const inserted = this.store.enqueue(message, evaluateMessagePolicy(this.config, message));
      if (inserted) for (const listener of this.queueChangedListeners) listener();
    });
  }

  async stop(): Promise<void> {
    await this.adapter.stop();
    this.store.close();
  }

  onQueueChanged(listener: () => void): () => void {
    this.queueChangedListeners.add(listener);
    return () => this.queueChangedListeners.delete(listener);
  }

  async nextMessage(consumerId: string, waitMs: number): Promise<ClaimedMessage | null> {
    const effectiveWait = Math.min(Math.max(waitMs, 0), this.config.maxLongPollMs);
    const deadline = Date.now() + effectiveWait;
    do {
      const message = this.store.claimNext(consumerId, this.config.leaseSeconds * 1000);
      if (message) return message;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
    } while (true);
  }

  async download(
    actor: string,
    messageId: string,
    leaseToken: string,
    attachmentId: string
  ): Promise<DownloadedAttachment> {
    const claimed = this.store.getClaimedMessage(messageId, leaseToken);
    if (claimed.scope.trustTier !== "trusted") throw new Error("attachment_download_requires_trusted_message");
    return downloadAttachment(this.config, this.store, actor, messageId, leaseToken, attachmentId);
  }

  async downloadConversationFile(
    actor: string,
    conversationId: string,
    fileAlias: string
  ): Promise<DownloadedConversationFile> {
    this.requireConversationAction(conversationId, "files_download");
    if (!this.adapter.downloadConversationFile) throw new Error("adapter_file_download_not_supported");
    const outputDir = join(this.config.runtimeDir, "downloads", conversationId.replace(/[^a-zA-Z0-9._-]/g, "_"));
    mkdirSync(outputDir, { recursive: true });
    const result = await this.adapter.downloadConversationFile(conversationId, fileAlias, outputDir);
    this.store.auditExternal("conversation_file_downloaded", actor, {
      conversationId,
      fileAlias,
      sizeBytes: result.sizeBytes,
      sha256: result.sha256
    });
    return result;
  }

  async listConversationFiles(actor: string, conversationId: string): Promise<ConversationFileInventory> {
    this.requireConversationAction(conversationId, "files_read");
    if (!this.adapter.listConversationFiles) throw new Error("adapter_file_list_not_supported");
    const result = await this.adapter.listConversationFiles(conversationId);
    this.store.auditExternal("conversation_files_listed", actor, {
      conversationId,
      fileCount: result.files.length,
      folderCount: result.folders.length
    });
    return result;
  }

  private requireConversationAction(conversationId: string, action: string): void {
    const policy = this.config.groups.find((item) => item.conversationId === conversationId);
    if (!policy?.enabled) throw new Error("conversation_not_enrolled");
    if (!policy.allowedActions.includes(action)) throw new Error("conversation_action_not_allowed");
  }

  async reply(
    actor: string,
    messageId: string,
    leaseToken: string,
    clientRequestId: string,
    textInput: string
  ): Promise<ReplyResult> {
    const claimed = this.store.getClaimedMessage(messageId, leaseToken);
    if (claimed.scope.replyPolicy === "none" || claimed.scope.trustTier === "rejected") {
      throw new Error("reply_not_allowed_by_message_policy");
    }

    const text = textInput.replace(/\u0000/g, "").trim();
    if (!text) throw new Error("reply_text_empty");
    if (text.length > this.config.maxReplyChars) throw new Error("reply_text_too_long");

    if (this.config.mode === "dry_run") {
      return this.store.beginReply(messageId, leaseToken, clientRequestId, text, "dry_run", actor).result;
    }

    if (this.config.presence.requireAwayForLiveReply) {
      const presence = await this.presence.snapshot();
      if (presence.state === "active" || presence.state === "quiescent" || presence.state === "unknown") {
        throw new Error(`live_reply_blocked_by_presence:${presence.state}`);
      }
      if (presence.state === "locked" && !this.adapter.canSendWhileLocked) {
        throw new Error("live_reply_blocked_while_session_locked");
      }
    }

    const begun = this.store.beginReply(messageId, leaseToken, clientRequestId, text, "queued", actor);
    if (!begun.created || !begun.pending) return begun.result;
    try {
      const receipt = await this.adapter.sendReply(begun.pending.message, text, clientRequestId);
      return this.store.finishReply(begun.pending.replyId, "sent", receipt);
    } catch (error) {
      return this.store.finishReply(
        begun.pending.replyId,
        "failed",
        undefined,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  complete(
    actor: string,
    messageId: string,
    leaseToken: string,
    outcome: "completed" | "retry" | "dead_letter"
  ): void {
    this.store.complete(messageId, leaseToken, actor, outcome);
    if (outcome === "retry") for (const listener of this.queueChangedListeners) listener();
  }

  presenceSnapshot(): Promise<PresenceSnapshot> {
    return this.presence.snapshot();
  }
}
