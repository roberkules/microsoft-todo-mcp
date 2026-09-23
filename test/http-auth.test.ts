import { beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { createCloudflareAccessVerifier, createTokenVerifier } from "../src/http/auth";
import { loadHttpConfig, type JwtHttpConfig, type CloudflareHttpConfig } from "../src/http/config";

const httpEnv = {
  MS_TODO_HTTP_PUBLIC_URL: "https://todo.example.com/mcp",
  MS_TODO_OAUTH_ISSUER: "https://issuer.example.com/",
  MS_TODO_OAUTH_JWKS_URL: "https://issuer.example.com/.well-known/jwks.json",
  MS_TODO_OAUTH_SUBJECT: "owner",
};
const cloudflareEnv = {
  MS_TODO_HTTP_PUBLIC_URL: "https://todo.example.com/mcp",
  MS_TODO_HTTP_AUTH_MODE: "cloudflare-access",
  MS_TODO_CF_ACCESS_ISSUER: "https://owner.cloudflareaccess.com",
  MS_TODO_CF_ACCESS_AUD: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  MS_TODO_CF_ACCESS_EMAIL: "owner@example.com",
};

describe("HTTP configuration", () => {
  it("requires all security settings", () => {
    for (const key of Object.keys(httpEnv)) {
      const env: Record<string, string> = { ...httpEnv };
      delete env[key];
      expect(() => loadHttpConfig(env)).toThrow();
    }
  });
  it("binds loopback by default", () => expect(loadHttpConfig(httpEnv).host).toBe("127.0.0.1"));
  it.each(["http://todo.example.com/mcp", "https://todo.example.com/", "https://user:pass@todo.example.com/mcp", "https://todo.example.com/mcp?secret=x"])("rejects unsafe public URL %s", (url) => {
    expect(() => loadHttpConfig({ ...httpEnv, MS_TODO_HTTP_PUBLIC_URL: url })).toThrow();
  });
  it.each(["0", "-1", "8000x", "65536"])("rejects invalid port %s", (port) => {
    expect(() => loadHttpConfig({ ...httpEnv, MS_TODO_HTTP_PORT: port })).toThrow();
  });
  it("requires a specific Access issuer, app audience and owner email", () => {
    const config = loadHttpConfig(cloudflareEnv) as CloudflareHttpConfig;
    expect(config.jwksUrl.href).toBe("https://owner.cloudflareaccess.com/cdn-cgi/access/certs");
    for (const key of ["MS_TODO_CF_ACCESS_ISSUER", "MS_TODO_CF_ACCESS_AUD", "MS_TODO_CF_ACCESS_EMAIL"]) {
      const env: Record<string, string> = { ...cloudflareEnv };
      delete env[key];
      expect(() => loadHttpConfig(env)).toThrow();
    }
    expect(() => loadHttpConfig({ ...cloudflareEnv, MS_TODO_CF_ACCESS_ISSUER: "https://issuer.example.com" })).toThrow();
    expect(() => loadHttpConfig({ ...cloudflareEnv, MS_TODO_CF_ACCESS_AUD: "wrong" })).toThrow();
    expect(() => loadHttpConfig({ ...httpEnv, MS_TODO_HTTP_AUTH_MODE: "disabled" })).toThrow();
  });
});

describe("MCP bearer verification", () => {
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let keys: JWTVerifyGetKey;
  const config = loadHttpConfig(httpEnv) as JwtHttpConfig;
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: "test", alg: "RS256" }] });
  });
  const sign = (overrides: Record<string, unknown> = {}) => new SignJWT({
    iss: config.issuer, aud: config.publicUrl.href, sub: "owner", scope: "todo:mcp",
    iat: 1_700_000_000, exp: 4_000_000_000, ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(privateKey);

  it("accepts a signed token for the owner and MCP resource", async () => {
    await expect(createTokenVerifier(config, keys)(await sign())).resolves.toBeUndefined();
  });
  it.each([
    { iss: "https://other.example.com/" }, { aud: "https://graph.microsoft.com" },
    { exp: 1 }, { exp: undefined }, { sub: undefined }, { nbf: 4_000_000_000 },
  ])("rejects invalid claims %j", async (claims) => {
    await expect(createTokenVerifier(config, keys)(await sign(claims))).rejects.toMatchObject({ status: 401 });
  });
  it.each([{ sub: "someone-else" }, { scope: "Tasks.ReadWrite" }, { scope: "todo:mcp-extra" }])("rejects unauthorized identity/scope %j", async (claims) => {
    await expect(createTokenVerifier(config, keys)(await sign(claims))).rejects.toMatchObject({ status: 403 });
  });
  it("rejects forged signatures and arbitrary bearer strings", async () => {
    const other = await generateKeyPair("RS256");
    const token = await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(other.privateKey);
    for (const value of [token, "static-secret", "malformed.jwt.value"]) {
      await expect(createTokenVerifier(config, keys)(value)).rejects.toMatchObject({ status: 401 });
    }
  });
});

describe("Cloudflare Access assertion verification", () => {
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let keys: JWTVerifyGetKey;
  const config = loadHttpConfig(cloudflareEnv) as CloudflareHttpConfig;
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: "test", alg: "RS256" }] });
  });
  const sign = (overrides: Record<string, unknown> = {}) => new SignJWT({
    iss: config.issuer, aud: [config.audience], sub: "owner-id", email: "owner@example.com", type: "app",
    iat: 1_700_000_000, nbf: 1_700_000_000, exp: 4_000_000_000, ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(privateKey);

  it("accepts a signed application assertion for the owner", async () => {
    await expect(createCloudflareAccessVerifier(config, keys)(await sign())).resolves.toBeUndefined();
  });
  it.each([
    { iss: "https://other.cloudflareaccess.com" }, { aud: ["other"] }, { exp: 1 },
    { exp: undefined }, { nbf: 4_000_000_000 },
  ])("rejects invalid Access claims %j", async (claims) => {
    await expect(createCloudflareAccessVerifier(config, keys)(await sign(claims))).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    { email: "other@example.com" }, { email: undefined }, { type: "org" }, { sub: "" },
  ])("rejects assertions not owned by the allowed user %j", async (claims) => {
    await expect(createCloudflareAccessVerifier(config, keys)(await sign(claims))).rejects.toMatchObject({ status: 403 });
  });
});
