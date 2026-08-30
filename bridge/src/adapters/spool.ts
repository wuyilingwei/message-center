import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { basename, join } from "node:path";
import * as z from "zod/v4";
import type { AppConfig } from "../config.js";
import type { IncomingBridgeMessage, BridgeAdapter } from "../types.js";

const IdentitySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).max(200),
  assurance: z.enum(["verified", "display_only"])
});

const AttachmentSchema = z.object({
  id: z.string().min(1),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(200).default("application/octet-stream"),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  stagedPath: z.string().min(1)
});

const ContextMessageSchema = z.object({
  messageId: z.string().min(1).max(300),
  senderId: z.string().min(1).max(300),
  senderName: z.string().min(1).max(200),
  receivedAt: z.iso.datetime(),
  text: z.string().max(2000)
});

const MessageSchema = z.object({
  id: z.string().min(1).default(() => randomUUID()),
  conversation: IdentitySchema,
  sender: IdentitySchema,
  receivedAt: z.iso.datetime().default(() => new Date().toISOString()),
  text: z.string().max(100_000),
  attachments: z.array(AttachmentSchema).max(20).default([]),
  conversationType: z.enum(["direct", "group"]).optional(),
  trigger: z.enum(["direct", "mention", "explicit_request", "background"]).optional(),
  mentioned: z.boolean().optional(),
  placement: z.enum(["normal", "folded", "message_box", "unknown"]).optional(),
  backupOnly: z.boolean().optional(),
  context: z.array(ContextMessageSchema).max(20).optional(),
  replyHandle: z.string().min(1)
});

export class SpoolBridgeAdapter implements BridgeAdapter {
  readonly name = "spool";
  readonly canSendWhileLocked = true;
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;
  private onMessage: ((message: IncomingBridgeMessage) => Promise<void>) | undefined;
  private readonly inboxDir: string;
  private readonly processedDir: string;
  private readonly rejectedDir: string;
  private readonly outboxDir: string;

  constructor(private readonly config: AppConfig) {
    this.inboxDir = join(config.runtimeDir, "inbox");
    this.processedDir = join(config.runtimeDir, "processed");
    this.rejectedDir = join(config.runtimeDir, "rejected");
    this.outboxDir = join(config.runtimeDir, "outbox");
  }

  async start(onMessage: (message: IncomingBridgeMessage) => Promise<void>): Promise<void> {
    this.onMessage = onMessage;
    for (const dir of [this.inboxDir, this.processedDir, this.rejectedDir, this.outboxDir, this.config.stagingDir]) {
      mkdirSync(dir, { recursive: true });
    }
    await this.scan();
    this.timer = setInterval(() => void this.scan(), 500);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async sendReply(message: IncomingBridgeMessage, text: string, idempotencyKey: string): Promise<string> {
    const receipt = randomUUID();
    const destination = join(this.outboxDir, `${receipt}.json`);
    writeFileSync(destination, `${JSON.stringify({
      receipt,
      adapter: this.name,
      messageId: message.id,
      replyHandle: message.replyHandle,
      idempotencyKey,
      text,
      createdAt: new Date().toISOString()
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return receipt;
  }

  private async scan(): Promise<void> {
    if (this.scanning || !this.onMessage) return;
    this.scanning = true;
    try {
      const files = readdirSync(this.inboxDir).filter((name) => name.toLowerCase().endsWith(".json")).sort();
      for (const name of files) await this.processFile(name);
    } finally {
      this.scanning = false;
    }
  }

  private async processFile(name: string): Promise<void> {
    if (!this.onMessage) return;
    const source = join(this.inboxDir, basename(name));
    if (!existsSync(source)) return;
    try {
      const raw = readFileSync(source, "utf8");
      const parsed = MessageSchema.parse(JSON.parse(raw)) as IncomingBridgeMessage;
      parsed.rawEventDigest = createHash("sha256").update(raw).digest("hex");
      await this.onMessage(parsed);
      renameSync(source, join(this.processedDir, basename(name)));
    } catch (error) {
      process.stderr.write(`Rejected spool event ${basename(name)}: ${error instanceof Error ? error.message : String(error)}\n`);
      if (existsSync(source)) renameSync(source, join(this.rejectedDir, `${Date.now()}-${basename(name)}`));
    }
  }
}
