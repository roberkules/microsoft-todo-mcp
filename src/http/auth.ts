import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { HttpConfig } from "./config";

export class HttpAuthError extends Error {
  constructor(readonly status: 401 | 403) { super("MCP authorization failed"); }
}

/** The single allowed subject owns the single Microsoft token cache. */
export function createTokenVerifier(config: HttpConfig, keys: JWTVerifyGetKey = createRemoteJWKSet(config.jwksUrl)) {
  return async (token: string): Promise<void> => {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience: config.publicUrl.href,
        algorithms: ["RS256", "ES256"],
        requiredClaims: ["exp", "sub", "iat"],
      }));
    } catch {
      throw new HttpAuthError(401);
    }
    if (payload.sub !== config.subject) throw new HttpAuthError(403);
    if (typeof payload.scope !== "string" || !payload.scope.split(" ").includes(config.scope)) throw new HttpAuthError(403);
  };
}
