import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";
import type {
  ClaimedAttachment,
  ClaimedMessage,
  IncomingAttachment,
  IncomingBridgeMessage,
  MessageScope,
  ReplyResult
} from "./types.js";

interface MessageRow {
  id: string;
  conversation_id: string;
  conversation_name: string;
  conversation_assurance: "verified" | "display_only";
  sender_id: string;
  sender_name: string;
  sender_assurance: "verified" | "display_only";
  received_at: string;
  text: string;
  reply_handle: string;
  raw_event_digest: string | null;
  scope_json: string;
  state: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  leased_by: string | null;
}

interface AttachmentRow {
  id: string;
  message_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string | null;
  staged_path: string;
  downloaded_path: string | null;
}

interface ReplyRow {
  id: string;
  message_id: string;
  client_request_id: string;
  status: ReplyResult["status"];
  adapter_receipt: string | null;
}

export interface PendingReply {
  replyId: string;
  message: IncomingBridgeMessage;
  text: string;
  clientRequestId: string;
}

export class MessageStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        conversation_name TEXT NOT NULL,
        conversation_assurance TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_assurance TEXT NOT NULL,
        received_at TEXT NOT NULL,
        text TEXT NOT NULL,
        reply_handle TEXT NOT NULL,
        raw_event_digest TEXT,
        scope_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        lease_token TEXT,
        lease_expires_at TEXT,
        leased_by TEXT,
        completed_at TEXT,
        outcome TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_pending_idx ON messages(state, received_at);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT NOT NULL,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT,
        staged_path TEXT NOT NULL,
        downloaded_path TEXT,
        PRIMARY KEY (id, message_id)
      );

      CREATE TABLE IF NOT EXISTS replies (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        client_request_id TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        adapter_receipt TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        action TEXT NOT NULL,
        message_id TEXT,
        actor TEXT,
        details_json TEXT NOT NULL
      );
    `);
  }

  enqueue(message: IncomingBridgeMessage, scope: MessageScope): boolean {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO messages (
          id, conversation_id, conversation_name, conversation_assurance,
          sender_id, sender_name, sender_assurance, received_at, text,
          reply_handle, raw_event_digest, scope_json, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        message.id,
        message.conversation.id,
        message.conversation.displayName,
        message.conversation.assurance,
        message.sender.id,
        message.sender.displayName,
        message.sender.assurance,
        message.receivedAt,
        message.text,
        message.replyHandle,
        message.rawEventDigest ?? null,
        JSON.stringify(scope),
        now
      ) as StatementResultingChanges;

      if (result.changes === 0) {
        this.db.exec("COMMIT");
        return false;
      }

      const insertAttachment = this.db.prepare(`
        INSERT INTO attachments (
          id, message_id, file_name, mime_type, size_bytes, sha256, staged_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const attachment of message.attachments) {
        insertAttachment.run(
          attachment.id,
          message.id,
          attachment.fileName,
          attachment.mimeType,
          attachment.sizeBytes,
          attachment.sha256 ?? null,
          attachment.stagedPath
        );
      }
      this.audit("message_enqueued", message.id, "adapter", {
        trustTier: scope.trustTier,
        reason: scope.reason,
        attachmentCount: message.attachments.length
      });
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claimNext(consumerId: string, leaseMs: number): ClaimedMessage | null {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const leaseToken = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE messages
        SET state = 'pending', lease_token = NULL, lease_expires_at = NULL, leased_by = NULL
        WHERE state = 'leased' AND lease_expires_at < ?
      `).run(nowIso);

      const row = this.db.prepare(`
        SELECT * FROM messages
        WHERE state = 'pending'
        ORDER BY received_at ASC
        LIMIT 1
      `).get() as unknown as MessageRow | undefined;

      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }

      this.db.prepare(`
        UPDATE messages
        SET state = 'leased', lease_token = ?, lease_expires_at = ?, leased_by = ?
        WHERE id = ? AND state = 'pending'
      `).run(leaseToken, leaseExpiresAt, consumerId, row.id);
      this.audit("message_claimed", row.id, consumerId, { leaseExpiresAt });
      this.db.exec("COMMIT");
      return this.toClaimedMessage({
        ...row,
        state: "leased",
        lease_token: leaseToken,
        lease_expires_at: leaseExpiresAt,
        leased_by: consumerId
      });
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getClaimedMessage(messageId: string, leaseToken: string): ClaimedMessage {
    return this.toClaimedMessage(this.requireLease(messageId, leaseToken));
  }

  private requireLease(messageId: string, leaseToken: string): MessageRow {
    const row = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId) as unknown as MessageRow | undefined;
    if (!row) throw new Error("message_not_found");
    if (row.state !== "leased" || row.lease_token !== leaseToken) throw new Error("invalid_message_lease");
    if (!row.lease_expires_at || row.lease_expires_at <= new Date().toISOString()) throw new Error("message_lease_expired");
    return row;
  }

  getAttachment(messageId: string, leaseToken: string, attachmentId: string): AttachmentRow {
    this.requireLease(messageId, leaseToken);
    const row = this.db.prepare(`
      SELECT * FROM attachments WHERE message_id = ? AND id = ?
    `).get(messageId, attachmentId) as unknown as AttachmentRow | undefined;
    if (!row) throw new Error("attachment_not_found_for_message");
    return row;
  }

  markAttachmentDownloaded(messageId: string, attachmentId: string, path: string, actor: string): void {
    this.db.prepare(`
      UPDATE attachments SET downloaded_path = ? WHERE message_id = ? AND id = ?
    `).run(path, messageId, attachmentId);
    this.audit("attachment_downloaded", messageId, actor, { attachmentId, path });
  }

  beginReply(
    messageId: string,
    leaseToken: string,
    clientRequestId: string,
    text: string,
    initialStatus: ReplyResult["status"],
    actor: string
  ): { created: boolean; result: ReplyResult; pending?: PendingReply } {
    const messageRow = this.requireLease(messageId, leaseToken);
    const existing = this.db.prepare(`
      SELECT id, message_id, client_request_id, status, adapter_receipt
      FROM replies WHERE client_request_id = ?
    `).get(clientRequestId) as unknown as ReplyRow | undefined;
    if (existing) {
      if (existing.message_id !== messageId) throw new Error("idempotency_key_reused_for_another_message");
      return {
        created: false,
        result: {
          replyId: existing.id,
          status: existing.status,
          ...(existing.adapter_receipt ? { adapterReceipt: existing.adapter_receipt } : {})
        }
      };
    }

    const replyId = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO replies (id, message_id, client_request_id, text, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(replyId, messageId, clientRequestId, text, initialStatus, now, now);
    this.audit("reply_created", messageId, actor, { replyId, status: initialStatus, textLength: text.length });
    return {
      created: true,
      result: { replyId, status: initialStatus },
      pending: {
        replyId,
        message: this.toIncomingMessage(messageRow),
        text,
        clientRequestId
      }
    };
  }

  finishReply(replyId: string, status: ReplyResult["status"], adapterReceipt?: string, error?: string): ReplyResult {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE replies SET status = ?, adapter_receipt = ?, error = ?, updated_at = ? WHERE id = ?
    `).run(status, adapterReceipt ?? null, error ?? null, now, replyId);
    const row = this.db.prepare(`
      SELECT id, message_id, client_request_id, status, adapter_receipt FROM replies WHERE id = ?
    `).get(replyId) as unknown as ReplyRow | undefined;
    if (!row) throw new Error("reply_not_found");
    this.audit("reply_finished", row.message_id, "adapter", { replyId, status, hasError: Boolean(error) });
    return {
      replyId,
      status,
      ...(adapterReceipt ? { adapterReceipt } : {})
    };
  }

  complete(messageId: string, leaseToken: string, actor: string, outcome: "completed" | "retry" | "dead_letter"): void {
    this.requireLease(messageId, leaseToken);
    const now = new Date().toISOString();
    if (outcome === "retry") {
      this.db.prepare(`
        UPDATE messages
        SET state = 'pending', lease_token = NULL, lease_expires_at = NULL, leased_by = NULL, outcome = ?
        WHERE id = ?
      `).run(outcome, messageId);
    } else {
      this.db.prepare(`
        UPDATE messages
        SET state = ?, lease_token = NULL, lease_expires_at = NULL, completed_at = ?, outcome = ?
        WHERE id = ?
      `).run(outcome === "completed" ? "completed" : "dead_letter", now, outcome, messageId);
    }
    this.audit("message_completed", messageId, actor, { outcome });
  }

  pendingCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM messages
      WHERE state = 'pending' OR (state = 'leased' AND lease_expires_at < ?)
    `).get(new Date().toISOString()) as unknown as { count: number };
    return Number(row.count);
  }

  auditExternal(action: string, actor: string, details: Record<string, unknown>): void {
    if (!/^[a-z][a-z0-9_]{2,80}$/.test(action)) throw new Error("invalid_audit_action");
    this.audit(action, null, actor, details);
  }

  private toClaimedMessage(row: MessageRow): ClaimedMessage {
    if (!row.lease_token || !row.lease_expires_at) throw new Error("message_is_not_leased");
    const attachmentRows = this.db.prepare(`
      SELECT * FROM attachments WHERE message_id = ? ORDER BY file_name ASC
    `).all(row.id) as unknown as AttachmentRow[];
    const attachments: ClaimedAttachment[] = attachmentRows.map((attachment) => ({
      id: attachment.id,
      fileName: attachment.file_name,
      mimeType: attachment.mime_type,
      sizeBytes: attachment.size_bytes,
      ...(attachment.sha256 ? { sha256: attachment.sha256 } : {})
    }));
    return {
      id: row.id,
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at,
      conversation: {
        id: row.conversation_id,
        displayName: row.conversation_name,
        assurance: row.conversation_assurance
      },
      sender: {
        id: row.sender_id,
        displayName: row.sender_name,
        assurance: row.sender_assurance
      },
      receivedAt: row.received_at,
      text: row.text,
      attachments,
      scope: JSON.parse(row.scope_json) as MessageScope
    };
  }

  private toIncomingMessage(row: MessageRow): IncomingBridgeMessage {
    const attachmentRows = this.db.prepare(`
      SELECT * FROM attachments WHERE message_id = ? ORDER BY file_name ASC
    `).all(row.id) as unknown as AttachmentRow[];
    const attachments: IncomingAttachment[] = attachmentRows.map((attachment) => ({
      id: attachment.id,
      fileName: attachment.file_name,
      mimeType: attachment.mime_type,
      sizeBytes: attachment.size_bytes,
      stagedPath: attachment.staged_path,
      ...(attachment.sha256 ? { sha256: attachment.sha256 } : {})
    }));
    return {
      id: row.id,
      conversation: {
        id: row.conversation_id,
        displayName: row.conversation_name,
        assurance: row.conversation_assurance
      },
      sender: {
        id: row.sender_id,
        displayName: row.sender_name,
        assurance: row.sender_assurance
      },
      receivedAt: row.received_at,
      text: row.text,
      attachments,
      replyHandle: row.reply_handle,
      ...(row.raw_event_digest ? { rawEventDigest: row.raw_event_digest } : {})
    };
  }

  private audit(action: string, messageId: string | null, actor: string | null, details: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO audit_log (occurred_at, action, message_id, actor, details_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(new Date().toISOString(), action, messageId, actor, JSON.stringify(details));
  }
}
