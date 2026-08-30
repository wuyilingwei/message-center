import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "./config.js";
import { createAdapter } from "./adapters/index.js";
import { PresenceService } from "./presence.js";
import type { IncomingBridgeMessage } from "./types.js";

interface CloudCommand {
  id: string;
  profileId: string;
  conversationId: string;
  kind: "send_text" | "list_files" | "download_file";
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

function requiredEnv(name: string, minimumLength = 1): string {
  const value = process.env[name];
  if (!value || value.length < minimumLength) throw new Error(`${name}_required`);
  return value;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok || body.ok === false) throw new Error(String(body.error ?? `http_${response.status}`));
  return body;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.adapter !== "device") throw new Error("cloud_relay_requires_device_adapter");
  const cloudUrl = requiredEnv("BRIDGE_CLOUD_URL").replace(/\/$/, "");
  const token = requiredEnv("BRIDGE_CLOUD_DEVICE_TOKEN", 32);
  const deviceId = requiredEnv("BRIDGE_CLOUD_DEVICE_ID");
  const displayName = process.env.BRIDGE_CLOUD_DEVICE_NAME || deviceId;
  const adapter = createAdapter(config);
  const presence = new PresenceService(config);
  const pendingDir = join(config.runtimeDir, "cloud", "pending-events");
  const sentDir = join(config.runtimeDir, "cloud", "sent-events");
  mkdirSync(pendingDir, { recursive: true });
  mkdirSync(sentDir, { recursive: true });

  const queueEvent = async (message: IncomingBridgeMessage): Promise<void> => {
    const destination = join(pendingDir, `${safeFilePart(message.id)}.json`);
    try {
      writeFileSync(destination, `${JSON.stringify(message)}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  };

  let lastHeartbeatAt = 0;
  const heartbeat = async (): Promise<void> => {
    if (Date.now() - lastHeartbeatAt < 15_000) return;
    const snapshot = await presence.snapshot();
    const response = await fetch(`${cloudUrl}/v1/device/heartbeat`, {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ deviceId, displayName, status: snapshot })
    });
    await responseJson(response);
    lastHeartbeatAt = Date.now();
  };

  const flushEvents = async (): Promise<void> => {
    const names = readdirSync(pendingDir).filter((name) => name.endsWith(".json")).sort().slice(0, 100);
    if (names.length === 0) return;
    const messages = names.map((name) => JSON.parse(readFileSync(join(pendingDir, name), "utf8")) as IncomingBridgeMessage);
    const byProfile = new Map<string, Array<{ name: string; message: IncomingBridgeMessage }>>();
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const name = names[index];
      if (!message || !name) continue;
      const profileId = message.id.split(":", 1)[0] || "default";
      const batch = byProfile.get(profileId) ?? [];
      batch.push({ name, message });
      byProfile.set(profileId, batch);
    }
    const snapshot = await presence.snapshot();
    for (const [profileId, batch] of byProfile) {
      const response = await fetch(`${cloudUrl}/v1/device/events`, {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        body: JSON.stringify({
          deviceId,
          displayName,
          profileId,
          status: snapshot,
          messages: batch.map((item) => item.message)
        })
      });
      await responseJson(response);
      for (const item of batch) {
        renameSync(join(pendingDir, item.name), join(sentDir, `${Date.now()}-${basename(item.name)}`));
      }
    }
  };

  const complete = async (command: CloudCommand, body: Record<string, unknown>): Promise<void> => {
    const response = await fetch(`${cloudUrl}/v1/device/commands/${encodeURIComponent(command.id)}/complete`, {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    await responseJson(response);
  };

  const uploadFile = async (command: CloudCommand, result: {
    path: string;
    fileName: string;
    sha256: string;
    sizeBytes: number;
  }): Promise<string> => {
    const content = readFileSync(result.path);
    if (content.length !== result.sizeBytes) throw new Error("downloaded_file_size_changed");
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== result.sha256) throw new Error("downloaded_file_digest_changed");
    const fileId = randomUUID();
    const response = await fetch(`${cloudUrl}/v1/device/files/${fileId}`, {
      method: "PUT",
      headers: {
        ...authHeaders(token),
        "content-type": "application/octet-stream",
        "content-length": String(content.length),
        "x-bridge-device-id": deviceId,
        "x-bridge-profile-id": command.profileId,
        "x-bridge-conversation-id": command.conversationId,
        "x-bridge-file-name": encodeURIComponent(result.fileName),
        "x-bridge-sha256": digest
      },
      body: content
    });
    await responseJson(response);
    return fileId;
  };

  const processCommand = async (command: CloudCommand): Promise<void> => {
    try {
      if (command.kind === "send_text") {
        if (config.presence.requireAwayForLiveReply) {
          const state = await presence.snapshot();
          if (["active", "quiescent", "unknown"].includes(state.state)) {
            await complete(command, { retry: true, error: `presence_${state.state}` });
            return;
          }
        }
        const message = command.payload.message as IncomingBridgeMessage | undefined;
        const text = String(command.payload.text ?? "");
        if (!message || !text) throw new Error("invalid_send_text_command");
        const receipt = await adapter.sendReply(message, text, command.idempotencyKey);
        await complete(command, { ok: true, result: { receipt } });
        return;
      }
      if (command.kind === "list_files") {
        if (!adapter.listConversationFiles) throw new Error("adapter_file_list_not_supported");
        const inventory = await adapter.listConversationFiles(command.conversationId);
        await complete(command, { ok: true, result: inventory });
        return;
      }
      if (command.kind === "download_file") {
        if (!adapter.downloadConversationFile) throw new Error("adapter_file_download_not_supported");
        const fileAlias = String(command.payload.fileAlias ?? "");
        const outputDir = join(config.runtimeDir, "cloud", "downloads", safeFilePart(command.conversationId));
        mkdirSync(outputDir, { recursive: true });
        const downloaded = await adapter.downloadConversationFile(command.conversationId, fileAlias, outputDir);
        const fileId = await uploadFile(command, {
          path: downloaded.path,
          fileName: downloaded.fileName,
          sha256: downloaded.sha256,
          sizeBytes: downloaded.sizeBytes
        });
        await complete(command, { ok: true, result: { ...downloaded, path: undefined, fileId } });
        return;
      }
      throw new Error("unsupported_command_kind");
    } catch (error) {
      await complete(command, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const pollCommands = async (): Promise<void> => {
    const response = await fetch(`${cloudUrl}/v1/device/commands?deviceId=${encodeURIComponent(deviceId)}&limit=10`, {
      headers: authHeaders(token)
    });
    const body = await responseJson(response) as unknown as { commands?: CloudCommand[] };
    for (const command of body.commands ?? []) await processCommand(command);
  };

  await adapter.start(queueEvent);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await adapter.stop();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  while (!stopped) {
    try {
      await heartbeat();
      await flushEvents();
      await pollCommands();
    } catch (error) {
      process.stderr.write(`cloud relay cycle failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[bridge-cloud-relay] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
