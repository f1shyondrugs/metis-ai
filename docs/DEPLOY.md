# Metis AI deployment notes

Keep deployment-specific URLs, credentials, host paths, and tokens **outside**
the repository. Use the private deployment environment to provide:

- `AI_CHAT_SECRETS_KEY`
- `CHAT_PASSWORD`
- `MCP_BEARER_TOKEN`
- `AI_CHAT_ROOT`
- `AI_CHAT_MCP_STATE_DIR`
- `AGENT_CWD`

Cursor credentials are configured per user in Settings → Providers and are
stored encrypted with `AI_CHAT_SECRETS_KEY`. Cursor uses its SDK connection
directly; there is no global Cursor API-key fallback or configurable base URL.

Build and run the application with the package manager configured for the
deployment (`pnpm`).

## MCP gateway

The gateway module is `packages/mcp-gateway/`.

`.env.example` defaults: `MCP_PORT=8787`, bind localhost. A live host may use a
different `MCP_PORT`.

**Do not treat localhost as authentication.** As of 11 Sep 2026 the gateway
still accepts unauthenticated requests from `127.0.0.1` (P0-1). Set a long
random `MCP_BEARER_TOKEN` and keep the listener off the public internet. See
[PRODUCTION-AUDIT.md](./PRODUCTION-AUDIT.md) and [SECURITY.md](../SECURITY.md).

Set `MCP_PORT`, `MCP_PUBLIC_URL`, and `MCP_BEARER_TOKEN` only in the private
environment.

## Security checklist

- Never commit `.env`, tokens, chat passwords, databases, logs, or `data/`.
- Rotate any credential that was ever present in a repository or log.
- Review shell, filesystem, Docker, systemd, and remote desktop tools before
  enabling them in a public deployment.
- Optional and remote MCP servers are disabled by default.
- Application login rate limits must use a trustworthy client IP (`x-real-ip`
  or the last XFF hop). First-hop XFF is attacker-controlled behind nginx
  `proxy_add_x_forwarded_for` (P1-1).
- Do not expose the legacy `x-chat-password` / `x-chat-username` path (P1-2).

## WebSocket browser server

The production start command is `pnpm start`, which runs `tsx server.mjs` so
the browser preview can use the authenticated WebSocket endpoint at
`/api/browser/stream`. If systemd starts Next directly, point `ExecStart` at
the package start command (or `tsx <install-dir>/server.mjs`) before reloading
the service. Do not expose the WebSocket endpoint without the same
authenticated reverse-proxy boundary as the application.

The generic Nginx template is `deploy/nginx/metis-ai.conf.template`. Replace
`YOUR_DOMAIN` and `YOUR_PORT` for the local deployment; never copy a host's
systemd unit or Nginx file unchanged to another machine.

## systemd

Live units (`metis-ai`, `metis-ai-worker`, `metis-ai-mcp`) must **not** be
stopped as a side effect of a test or docs change. Restart only on explicit
operator request. cgroup `MemoryMax` / `TasksMax` were missing at audit time
(P1-5).
