import { afterEach, describe, expect, it } from "vitest";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/http/server";
import { HttpAuthError } from "../src/http/auth";
import { loadHttpConfig, type HttpConfig } from "../src/http/config";
import { loadConfig } from "../src/config";
import { createServerFactory } from "../src/server";
import { createLogger } from "../src/lib/logger";

const config = loadHttpConfig({
  MS_TODO_HTTP_PUBLIC_URL: "https://todo.example.com/mcp",
  MS_TODO_OAUTH_ISSUER: "https://issuer.example.com/",
  MS_TODO_OAUTH_JWKS_URL: "https://issuer.example.com/jwks",
  MS_TODO_OAUTH_SUBJECT: "owner",
});
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

async function setup(readonly = false, httpConfig: HttpConfig = config, validToken = "test-owner") {
  // Empty client ID prevents all Microsoft/cache I/O in these protocol tests.
  const factory = await createServerFactory(loadConfig({ MS_TODO_CLIENT_ID: "", LOG_LEVEL: "silent", MS_TODO_READONLY: readonly ? "1" : "0" }));
  const server = createHttpServer(httpConfig, factory, createLogger("silent"), async (token) => {
    if (token !== validToken) throw new HttpAuthError(401);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as AddressInfo).port;
  return (body?: unknown, options: { path?: string; method?: string; headers?: Record<string, string>; raw?: string } = {}) => new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: options.path ?? "/mcp", method: options.method ?? "POST", headers: {
      Host: httpConfig.publicUrl.host, Authorization: "Bearer test-owner",
      Accept: "application/json, text/event-stream", "Content-Type": "application/json",
      ...options.headers,
    } }, (res) => {
      let text = "";
      res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(options.raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}
const rpc = (method: string, params?: unknown, id = 1) => ({ jsonrpc: "2.0", id, method, params });

describe("Streamable HTTP", () => {
  it("initializes, accepts notifications, lists tools and calls a read tool", async () => {
    const call = await setup();
    const init = await call(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } }));
    expect(init.status).toBe(200);
    expect(JSON.parse(init.body).result.serverInfo.name).toBe("microsoft-todo-mcp");
    expect(init.headers["mcp-session-id"]).toBeUndefined();
    expect((await call({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const tools = await call(rpc("tools/list"));
    expect(JSON.parse(tools.body).result.tools.map((t: { name: string }) => t.name)).toContain("create_task");
    const status = await call(rpc("tools/call", { name: "auth_status", arguments: {} }));
    expect(status.status).toBe(200);
    expect(JSON.parse(JSON.parse(status.body).result.content[0].text).state).toBe("uninitialized");
  });

  it("keeps simultaneous request IDs and responses isolated", async () => {
    const call = await setup();
    const results = await Promise.all(Array.from({ length: 8 }, (_, id) => call(rpc("tools/list", {}, id))));
    expect(results.map((r) => JSON.parse(r.body).id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("preserves readonly tool filtering", async () => {
    const call = await setup(true);
    const result = JSON.parse((await call(rpc("tools/list"))).body);
    expect(result.result.tools.map((t: { name: string }) => t.name)).not.toContain("create_task");
  });

  it("requires authentication on every MCP method and advertises discovery", async () => {
    const call = await setup();
    for (const method of ["POST", "GET", "DELETE"]) {
      for (const authorization of ["", "Bearer invalid"]) {
        const response = await call(undefined, { method, headers: { Authorization: authorization } });
        expect(response.status).toBe(401);
        expect(response.headers["www-authenticate"]).toContain("https://todo.example.com/.well-known/oauth-protected-resource/mcp");
      }
    }
    const metadata = await call(undefined, { path: "/.well-known/oauth-protected-resource/mcp", method: "GET", headers: { Authorization: "" } });
    expect(JSON.parse(metadata.body)).toMatchObject({ resource: config.publicUrl.href, authorization_servers: [config.issuer] });
  });

  it("rejects untrusted Host and Origin headers even with credentials", async () => {
    const call = await setup();
    for (const headers of [{ Host: "attacker.example" }, { Origin: "https://attacker.example" }] as Record<string, string>[]) {
      expect((await call(rpc("tools/list"), { headers })).status).toBe(403);
    }
  });

  it("bounds input and implements stateless method semantics", async () => {
    const call = await setup();
    expect((await call(undefined, { raw: "{" })).status).toBe(400);
    expect((await call(undefined, { raw: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect((await call({}, { headers: { "Content-Type": "text/plain" } })).status).toBe(415);
    expect((await call(undefined, { method: "GET" })).status).toBe(405);
    expect((await call(undefined, { method: "DELETE" })).status).toBe(405);
    expect((await call(undefined, { method: "GET", path: "/healthz" })).status).toBe(200);
  });

  it("requires the Access assertion header in Cloudflare mode", async () => {
    const accessConfig = loadHttpConfig({
      MS_TODO_HTTP_PUBLIC_URL: "https://todo.example.com/mcp",
      MS_TODO_HTTP_AUTH_MODE: "cloudflare-access",
      MS_TODO_CF_ACCESS_ISSUER: "https://owner.cloudflareaccess.com",
      MS_TODO_CF_ACCESS_AUD: "1234567890abcdef1234567890abcdef",
      MS_TODO_CF_ACCESS_EMAIL: "owner@example.com",
    });
    const call = await setup(false, accessConfig, "valid-assertion");
    const list = rpc("tools/list");
    const noAssertion = await call(list);
    expect(noAssertion.status).toBe(401);
    expect(noAssertion.headers["www-authenticate"]).toBeUndefined();
    expect((await call(list, { headers: { "Cf-Access-Jwt-Assertion": "invalid" } })).status).toBe(401);
    expect((await call(list, { headers: { "Cf-Access-Jwt-Assertion": "valid-assertion", Authorization: "" } })).status).toBe(200);
    expect((await call(undefined, { method: "GET", path: "/.well-known/oauth-protected-resource" })).status).toBe(404);
  });
});
