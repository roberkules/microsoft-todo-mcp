import { beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { createTokenVerifier } from "../src/http/auth";
import { loadHttpConfig } from "../src/http/config";

const httpEnv = {
  MS_TODO_HTTP_PUBLIC_URL: "https://todo.example.com/mcp",
  MS_TODO_OAUTH_ISSUER: "https://issuer.example.com/",
  MS_TODO_OAUTH_JWKS_URL: "https://issuer.example.com/.well-known/jwks.json",
  MS_TODO_OAUTH_SUBJECT: "owner",
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
});

describe("MCP bearer verification", () => {
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let keys: JWTVerifyGetKey;
  const config = loadHttpConfig(httpEnv);
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
