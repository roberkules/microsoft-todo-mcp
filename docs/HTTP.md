# Streamable HTTP (single Microsoft account)

Stdio remains the default (`microsoft-todo-mcp`). Select HTTP explicitly with
`microsoft-todo-mcp serve --http`. The same tools and read-only flags work in both
modes. This is a **single-owner** server: one Microsoft account/cache and one
allowlisted OAuth subject. Do not use it as a multi-user service.

## Two independent authorizations

1. Microsoft Graph: use `microsoft-todo-mcp login` and Microsoft's device-code
   flow. MSAL persists/refreshes the Microsoft credentials. A dedicated Entra
   public-client registration with delegated `Tasks.ReadWrite` is recommended;
   MSAL also requests identity/offline-access scopes. No client secret or
   Microsoft password is stored. The shared Graph CLI identity can have other
   previously consented permissions, so it is not an isolated permission boundary.
2. MCP: configure an existing OAuth authorization server, then set the variables
   below. HTTP mode verifies its RS256/ES256 JWT access tokens using `jose`.
   Signature, issuer, audience, expiry, required scope, and exact subject are
   checked on every `/mcp` request. Graph access tokens are **not** MCP credentials.

| Variable | Value |
| --- | --- |
| `MS_TODO_HTTP_PUBLIC_URL` | Required canonical HTTPS URL, e.g. `https://todo.example.com/mcp` |
| `MS_TODO_OAUTH_ISSUER` | Required exact issuer, including trailing slash if present |
| `MS_TODO_OAUTH_JWKS_URL` | Required HTTPS URL of that issuer's public signing keys |
| `MS_TODO_OAUTH_SUBJECT` | Required exact `sub` of the single authorized owner |
| `MS_TODO_OAUTH_SCOPE` | Required token scope; defaults to `todo:mcp` |
| `MS_TODO_HTTP_HOST` | Bind address; defaults to `127.0.0.1` |
| `MS_TODO_HTTP_PORT` | Port; defaults to `8000` |
| `MS_TODO_TOKEN_CACHE` | Persistent private cache path; existing stdio setting |

There is no unauthenticated HTTP mode or static-token fallback. Tokens must carry
`iss`, `aud`, `sub`, `exp`, `iat`, and a space-delimited `scope` claim. The audience
must be the exact public MCP URL. The signing-key URL is configured by the operator,
never taken from a token. Discovery metadata and `/healthz` are public and contain
no account or token information.

The authorization server must support MCP-compatible authorization-code + S256
PKCE, discovery, resource/audience binding, and a client registration mechanism
supported by your MCP client (pre-registration, CIMD, or DCR). Configure the exact
callback URI shown by the client; disable public enrollment or otherwise limit
access to the owner. For Auth0, enable its Resource Parameter Compatibility Profile
when using the MCP `resource` parameter. The server does not implement OAuth login,
token issuance, or client registration itself.

OAuth discovery is available at `/.well-known/oauth-protected-resource/mcp`
(also the root metadata alias). Missing/invalid tokens receive HTTP 401 plus a
`WWW-Authenticate` challenge; valid tokens for an unauthorized subject/scope receive
403. This supports remote clients such as ChatGPT when an appropriate authorization
server has been configured. A URL alone is not sufficient setup.

## Transport and proxy configuration

`POST /mcp` implements stateless Streamable HTTP using the official MCP SDK and
JSON responses. `GET` and `DELETE /mcp` return 405 after authentication; standalone
SSE, resumable sessions and server-initiated notifications are not offered. Each
request has its own protocol server, sharing one Graph/auth context per process.
Request bodies are limited to 1 MiB and concurrent MCP requests to 32.

Terminate HTTPS at a reverse proxy or existing tunnel. Preserve the public `Host`
and `Authorization` headers, route the metadata paths as well as `/mcp`, and apply
edge rate limits. Forwarded identity headers are not trusted. Browser `Origin`,
when present, must match the public URL's origin. Host must match the public URL
or the loopback address/port used for health checks. The backend itself serves
plain HTTP and must remain on loopback or a private container network.

## Docker example

The example uses a pinned Node 24 LTS patch. Set `NODE_VERSION` at build time to
update the base intentionally. Pin the built image by digest for production.
Copy `compose.example.yml` to `compose.yml`, configure the variables above in a
local `.env` (ignored by Git), and create the token directory before startup:

```sh
mkdir -m 700 data
# The image runs as UID/GID 1000. Adjust ownership if your host user differs.
docker compose build
docker compose run --rm --no-deps todo-mcp login
docker compose up -d --no-deps todo-mcp
docker compose logs --tail 100 todo-mcp
```

The service publishes only `127.0.0.1:8000`. For a tunnel on a shared Docker
network, remove `ports`, attach only the required network, and route to
`http://todo-mcp:8000`. No privileged mode, Docker socket or host network is needed.
The image build context explicitly excludes everything except build inputs.

The cache is `./data/token-cache.json` on the host and `/data/token-cache.json`
inside the container. Keep the directory mode 0700, file mode 0600, and any backup
equally private. Never commit or copy the cache into an image. No local MCP signing
keys or refresh-token database are needed: the external OAuth provider manages
MCP credentials and its public verification keys are fetched as needed.

For Microsoft re-login, stop only this service, run the login command above, then
start it again. Avoid a CLI login process writing the same cache while the service
is running. Token revocation or tenant policy can still require re-login.

For updates, back up configuration and private state securely, check out a reviewed
release/commit, build, and run `docker compose up -d --no-deps todo-mcp`. Retain the
previous image digest for rollback. Restart with `docker compose restart todo-mcp`.
For removal, remove the public route first, stop/remove only this dedicated Compose
project, and revoke its Microsoft consent and MCP authorization. Retain or securely
delete `data` deliberately; never prune unrelated Docker resources.

## Verification

`npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` cover both
transports' shared registry and HTTP protocol/authentication behavior. Tests use
ephemeral loopback servers, locally signed JWTs and no Microsoft credentials.
Before production use, separately verify OAuth linking from your real client,
Microsoft login/refresh across restarts, and writes against a disposable task.
Do not test writes against existing tasks.
