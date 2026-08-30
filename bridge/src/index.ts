import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler
} from "@modelcontextprotocol/node";
import { loadConfig } from "./config.js";
import { createAdapter } from "./adapters/index.js";
import { createBridgeMcpServer } from "./mcp.js";
import { BridgeService } from "./service.js";

function stderr(message: string): void {
  process.stderr.write(`[bridge-message-center] ${message}\n`);
}

function bearerMatches(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return supplied.length === expectedBuffer.length && timingSafeEqual(supplied, expectedBuffer);
}

function rejectUnauthorized(response: ServerResponse): void {
  response.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": "Bearer"
  });
  response.end(JSON.stringify({ error: "unauthorized" }));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const adapter = createAdapter(config);
  const service = new BridgeService(config, adapter);
  await service.start();
  stderr(`adapter=${adapter.name} mode=${config.mode} transport=${config.transport}`);

  let stdioHandle: StdioServerHandle | undefined;
  let httpServer: ReturnType<typeof createServer> | undefined;
  let httpHandler: ReturnType<typeof createMcpHandler> | undefined;
  const activeStdioServers = new Set<McpServer>();

  if (config.transport === "stdio") {
    stdioHandle = serveStdio(() => {
      const server = createBridgeMcpServer(service);
      activeStdioServers.add(server);
      return server;
    }, { onerror: (error) => stderr(error.message) });
    service.onQueueChanged(() => {
      for (const server of activeStdioServers) {
        void server.server.sendResourceUpdated({ uri: "bridge://queue/status" }).catch((error: unknown) => {
          stderr(`resource notification failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    });
  } else {
    if (!new Set(["127.0.0.1", "::1", "localhost"]).has(config.http.host)) {
      throw new Error("http_host_must_be_loopback; place a mutually authenticated gateway or VPN in front of this service");
    }
    const token = process.env[config.http.tokenEnv];
    if (!token || token.length < 32) {
      throw new Error(`${config.http.tokenEnv} must contain at least 32 characters for HTTP mode`);
    }

    httpHandler = createMcpHandler(() => createBridgeMcpServer(service), {
      responseMode: "auto",
      onerror: (error) => stderr(error.message)
    });
    const nodeHandler = toNodeHandler(httpHandler, { onerror: (error) => stderr(error.message) });
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();

    httpServer = createServer((request, response) => {
      if (request.url === "/healthz" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (!request.url?.startsWith("/mcp")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      if (!validateHost(request, response) || !validateOrigin(request, response)) return;
      if (!bearerMatches(request, token)) {
        rejectUnauthorized(response);
        return;
      }
      void (nodeHandler as unknown as (req: IncomingMessage, res: ServerResponse) => Promise<void>)(request, response);
    });

    service.onQueueChanged(() => {
      httpHandler?.notify.resourceUpdated("bridge://queue/status");
    });

    await new Promise<void>((resolve, reject) => {
      httpServer?.once("error", reject);
      httpServer?.listen(config.http.port, config.http.host, () => {
        stderr(`listening=http://${config.http.host}:${config.http.port}/mcp`);
        resolve();
      });
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stderr(`shutdown=${signal}`);
    await stdioHandle?.close();
    await httpHandler?.close();
    if (httpServer) await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    await service.stop();
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  stderr(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
