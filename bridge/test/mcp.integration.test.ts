import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { testConfig, writeConfig } from "./helpers.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed_to_allocate_test_port");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("http_mcp_did_not_start");
}

test("stdio MCP claims, dry-runs reply, and completes a spool message", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-mcp-e2e-"));
  const config = testConfig(root);
  writeConfig(config.configPath, config);
  const inbox = join(config.runtimeDir, "inbox");
  mkdirSync(inbox, { recursive: true });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(projectRoot, "src/index.ts")],
    cwd: projectRoot,
    env: { ...process.env, BRIDGE_MCP_CONFIG: config.configPath } as Record<string, string>
  });
  const client = new Client({ name: "bridge-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    writeFileSync(join(inbox, "event.json"), JSON.stringify({
      id: "integration-message",
      conversation: { id: "group-1", displayName: "Team", assurance: "verified" },
      sender: { id: "member-1", displayName: "Engineer", assurance: "verified" },
      receivedAt: new Date().toISOString(),
      text: "/agent diagnose service-a",
      attachments: [],
      replyHandle: "reply-integration"
    }), "utf8");

    const next = await client.callTool({
      name: "next_message",
      arguments: { consumerId: "integration-worker", waitMs: 5000 }
    });
    assert.equal(next.isError, undefined);
    const nextBody = next.structuredContent as { found: boolean; message: { id: string; leaseToken: string } };
    assert.equal(nextBody.found, true);
    assert.equal(nextBody.message.id, "integration-message");

    const reply = await client.callTool({
      name: "reply_message",
      arguments: {
        consumerId: "integration-worker",
        messageId: nextBody.message.id,
        leaseToken: nextBody.message.leaseToken,
        clientRequestId: "integration-request-0001",
        text: "收到，正在进行受限诊断。"
      }
    });
    const replyBody = reply.structuredContent as { status: string };
    assert.equal(replyBody.status, "dry_run");

    const complete = await client.callTool({
      name: "complete_message",
      arguments: {
        consumerId: "integration-worker",
        messageId: nextBody.message.id,
        leaseToken: nextBody.message.leaseToken,
        outcome: "completed"
      }
    });
    assert.equal(complete.isError, undefined);
  } finally {
    await client.close();
  }
});

test("HTTP MCP binds to loopback and requires bearer authentication", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-mcp-http-"));
  const port = await freePort();
  const config = testConfig(root, {
    transport: "http",
    http: { host: "127.0.0.1", port, tokenEnv: "BRIDGE_MCP_TEST_TOKEN" }
  });
  writeConfig(config.configPath, config);
  const token = "test-token-that-is-at-least-thirty-two-characters";
  const child = spawn(process.execPath, ["--import", "tsx", join(projectRoot, "src/index.ts")], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, BRIDGE_MCP_CONFIG: config.configPath, BRIDGE_MCP_TEST_TOKEN: token }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  try {
    await waitForHealth(`http://127.0.0.1:${port}/healthz`);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`);
    assert.equal(unauthorized.status, 401);

    const client = new Client({ name: "bridge-mcp-http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    });
    await client.connect(transport);
    try {
      const presence = await client.callTool({ name: "presence_status", arguments: {} });
      assert.equal(presence.isError, undefined);
      assert.ok(presence.structuredContent);
    } finally {
      await client.close();
    }
  } finally {
    child.kill();
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else child.once("exit", () => resolveExit());
    });
  }
  assert.match(stderr, /transport=http/);
});
