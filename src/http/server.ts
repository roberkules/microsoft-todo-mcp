import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "../lib/logger";
import type { HttpConfig } from "./config";
import { createCloudflareAccessVerifier, createTokenVerifier, HttpAuthError } from "./auth";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CONCURRENT_REQUESTS = 32;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

export function createHttpServer(
  config: HttpConfig,
  createMcpServer: () => McpServer,
  logger: Logger,
  verifyToken: (token: string) => Promise<void> = config.authMode === "jwt"
    ? createTokenVerifier(config) : createCloudflareAccessVerifier(config),
) {
  let active = 0;
  const metadataPath = "/.well-known/oauth-protected-resource/mcp";
  const metadataUrl = new URL(metadataPath, config.publicUrl).href;
  const allowedHosts = new Set([config.publicUrl.host, `localhost:${config.port}`, `127.0.0.1:${config.port}`]);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // Forwarded headers are deliberately not trusted. Proxies must preserve Host.
    if (!req.headers.host || !allowedHosts.has(req.headers.host)) {
      json(res, 403, { error: "Invalid Host" }); return;
    }
    if (req.headers.origin && req.headers.origin !== config.publicUrl.origin) {
      json(res, 403, { error: "Invalid Origin" }); return;
    }
    if (req.url === "/healthz" && req.method === "GET") {
      json(res, 200, { status: "ok" }); return;
    }
    if (config.authMode === "jwt" && [metadataPath, "/.well-known/oauth-protected-resource"].includes(req.url ?? "") && req.method === "GET") {
      json(res, 200, { resource: config.publicUrl.href, authorization_servers: [config.issuer], scopes_supported: [config.scope], bearer_methods_supported: ["header"] });
      return;
    }
    if (req.url !== "/mcp") { json(res, 404, { error: "Not found" }); return; }
    if (active >= MAX_CONCURRENT_REQUESTS) { json(res, 503, { error: "Server busy" }); return; }
    active++;
    let mcp: McpServer | undefined;
    try {
      const token = config.authMode === "jwt"
        ? /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? "")?.[1]
        : req.headers["cf-access-jwt-assertion"];
      if (typeof token !== "string" || !token) throw new HttpAuthError(401);
      await verifyToken(token);
      // Stateless HTTP has no standalone SSE stream or sessions to delete.
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST"); json(res, 405, { error: "Method not allowed" }); return;
      }
      if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        json(res, 415, { error: "Expected application/json" }); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        const buffer = Buffer.from(chunk as Uint8Array);
        size += buffer.length;
        if (size > MAX_BODY_BYTES) {
          res.setHeader("Connection", "close");
          json(res, 413, { error: "Request too large" }); return;
        }
        chunks.push(buffer);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { json(res, 400, { error: "Invalid JSON" }); return; }
      // A transport may handle only one request in stateless mode. Share the tool
      // context, not the protocol server, to prevent cross-request response routing.
      mcp = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport);
      const closed = new Promise<void>((resolve) => res.once("close", resolve));
      await transport.handleRequest(req, res, body);
      await closed;
    } catch (err) {
      if (!res.headersSent) {
        if (err instanceof HttpAuthError) {
          // In Access mode, Cloudflare owns OAuth discovery and challenges at the edge.
          if (config.authMode === "jwt") {
            res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}", scope="${config.scope}", error="${err.status === 401 ? "invalid_token" : "insufficient_scope"}"`);
          }
          json(res, err.status, { error: "Unauthorized" });
        } else {
          logger.error("HTTP request failed");
          json(res, 500, { error: "Internal server error" });
        }
      } else if (!res.writableEnded) res.end();
    } finally {
      await mcp?.close().catch(() => logger.warn("HTTP transport close failed"));
      active--;
    }
  };
  const server = createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.timeout = 120_000;
  return server;
}

export async function startHttpServer(config: HttpConfig, createMcpServer: () => McpServer, logger: Logger) {
  const server = createHttpServer(config, createMcpServer, logger);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => { server.off("error", reject); resolve(); });
  });
  logger.info("Streamable HTTP listening", { host: config.host, port: config.port });
  return server;
}
