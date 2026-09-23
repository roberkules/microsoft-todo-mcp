import { AppError } from "../graph/errors";

interface HttpBaseConfig {
  host: string;
  port: number;
  publicUrl: URL;
}

export interface JwtHttpConfig extends HttpBaseConfig {
  authMode: "jwt";
  issuer: string;
  jwksUrl: URL;
  subject: string;
  scope: string;
}

export interface CloudflareHttpConfig extends HttpBaseConfig {
  authMode: "cloudflare-access";
  issuer: string;
  jwksUrl: URL;
  audience: string;
  ownerEmail: string;
}

export type HttpConfig = JwtHttpConfig | CloudflareHttpConfig;

export function loadHttpConfig(env: NodeJS.ProcessEnv): HttpConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new AppError("config_error", `${name} is required for HTTP mode.`);
    return value;
  };
  const httpsUrl = (name: string): URL => {
    try {
      const url = new URL(required(name));
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
      return url;
    } catch {
      throw new AppError("config_error", `${name} must be an HTTPS URL without credentials, query, or fragment.`);
    }
  };
  const publicUrl = httpsUrl("MS_TODO_HTTP_PUBLIC_URL");
  if (publicUrl.pathname !== "/mcp") throw new AppError("config_error", "MS_TODO_HTTP_PUBLIC_URL must end in /mcp.");
  const port = Number(env.MS_TODO_HTTP_PORT ?? "8000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError("config_error", "Invalid MS_TODO_HTTP_PORT.");
  const base = { host: env.MS_TODO_HTTP_HOST ?? "127.0.0.1", port, publicUrl };
  const authMode = env.MS_TODO_HTTP_AUTH_MODE ?? "jwt";
  if (authMode === "cloudflare-access") {
    const issuerUrl = httpsUrl("MS_TODO_CF_ACCESS_ISSUER");
    if (issuerUrl.pathname !== "/" || !issuerUrl.hostname.endsWith(".cloudflareaccess.com")) {
      throw new AppError("config_error", "MS_TODO_CF_ACCESS_ISSUER must be a Cloudflare Access team domain.");
    }
    const audience = required("MS_TODO_CF_ACCESS_AUD");
    if (!/^[0-9a-f]{64}$/i.test(audience)) throw new AppError("config_error", "Invalid Cloudflare Access application AUD tag.");
    const ownerEmail = required("MS_TODO_CF_ACCESS_EMAIL").toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new AppError("config_error", "Invalid Cloudflare Access owner email.");
    return {
      ...base, authMode, issuer: issuerUrl.origin,
      jwksUrl: new URL("/cdn-cgi/access/certs", issuerUrl), audience, ownerEmail,
    };
  }
  if (authMode !== "jwt") throw new AppError("config_error", "Invalid MS_TODO_HTTP_AUTH_MODE.");
  const issuer = required("MS_TODO_OAUTH_ISSUER");
  httpsUrl("MS_TODO_OAUTH_ISSUER");
  const scope = env.MS_TODO_OAUTH_SCOPE ?? "todo:mcp";
  if (!/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)) throw new AppError("config_error", "MS_TODO_OAUTH_SCOPE must be one OAuth scope token.");
  return {
    ...base, authMode, issuer,
    jwksUrl: httpsUrl("MS_TODO_OAUTH_JWKS_URL"),
    subject: required("MS_TODO_OAUTH_SUBJECT"), scope,
  };
}
