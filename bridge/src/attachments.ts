import { constants, copyFileSync, createReadStream, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import type { AppConfig } from "./config.js";
import type { MessageStore } from "./store.js";

export interface DownloadedAttachment {
  messageId: string;
  attachmentId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  localPath: string;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function safeFileName(input: string): string {
  const cleaned = basename(input)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  if (!cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) {
    return `attachment-${Date.now()}.bin`;
  }
  return cleaned;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function downloadAttachment(
  config: AppConfig,
  store: MessageStore,
  actor: string,
  messageId: string,
  leaseToken: string,
  attachmentId: string
): Promise<DownloadedAttachment> {
  const attachment = store.getAttachment(messageId, leaseToken, attachmentId);
  const extension = extname(attachment.file_name).toLowerCase();
  if (config.blockedAttachmentExtensions.map((value) => value.toLowerCase()).includes(extension)) {
    throw new Error("attachment_type_blocked");
  }
  if (attachment.size_bytes > config.maxAttachmentBytes) throw new Error("attachment_too_large");

  mkdirSync(config.stagingDir, { recursive: true });
  const stagingRoot = realpathSync(config.stagingDir);
  const sourcePath = realpathSync(attachment.staged_path);
  if (!isInside(stagingRoot, sourcePath)) throw new Error("attachment_source_outside_staging_root");
  const sourceStat = statSync(sourcePath);
  if (!sourceStat.isFile()) throw new Error("attachment_source_not_a_file");
  if (sourceStat.size !== attachment.size_bytes) throw new Error("attachment_size_mismatch");

  const sourceSha = await sha256File(sourcePath);
  if (attachment.sha256 && sourceSha.toLowerCase() !== attachment.sha256.toLowerCase()) {
    throw new Error("attachment_sha256_mismatch");
  }

  const downloadRoot = join(config.runtimeDir, "downloads");
  const messageDir = join(downloadRoot, messageId.replace(/[^a-zA-Z0-9._-]/g, "_"));
  mkdirSync(messageDir, { recursive: true });
  const destination = join(messageDir, `${attachmentId.replace(/[^a-zA-Z0-9._-]/g, "_")}-${safeFileName(attachment.file_name)}`);

  if (existsSync(destination)) {
    const existingSha = await sha256File(destination);
    if (existingSha !== sourceSha) throw new Error("attachment_destination_collision");
  } else {
    copyFileSync(sourcePath, destination, constants.COPYFILE_EXCL);
  }

  store.markAttachmentDownloaded(messageId, attachmentId, destination, actor);
  return {
    messageId,
    attachmentId,
    fileName: attachment.file_name,
    mimeType: attachment.mime_type,
    sizeBytes: attachment.size_bytes,
    sha256: sourceSha,
    localPath: destination
  };
}
