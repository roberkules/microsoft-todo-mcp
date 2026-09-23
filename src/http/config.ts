import { AppError } from "../graph/errors";

export interface HttpConfig {
  host: string;
  port: number;
  publicUrl: URL;
  issuer: string;
  jwksUrl: URL;
  subject: string;
  scope: string;
}

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
  const issuer = required("MS_TODO_OAUTH_ISSUER");
  httpsUrl("MS_TODO_OAUTH_ISSUER");
  const port = Number(env.MS_TODO_HTTP_PORT ?? "8000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError("config_error", "Invalid MS_TODO_HTTP_PORT.");
  const scope = env.MS_TODO_OAUTH_SCOPE ?? "todo:mcp";
  if (!/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)) throw new AppError("config_error", "MS_TODO_OAUTH_SCOPE must be one OAuth scope token.");
  return {
    host: env.MS_TODO_HTTP_HOST ?? "127.0.0.1", port, publicUrl, issuer,
    jwksUrl: httpsUrl("MS_TODO_OAUTH_JWKS_URL"),
    subject: required("MS_TODO_OAUTH_SUBJECT"), scope,
  };
}
