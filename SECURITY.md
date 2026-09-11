# Security notes

Metis AI can execute tools that affect files, processes, containers, services,
and connected desktop devices. Treat a deployment as privileged infrastructure.

## Public deployment checklist

1. Set a unique `CHAT_PASSWORD` and `MCP_BEARER_TOKEN` outside Git.
2. Keep the MCP gateway bound to localhost or put it behind an authenticated,
   trusted network boundary.
3. Leave `MCP_ALLOW_REMOTE_ADMIN=false` unless remote administration is
   explicitly required and separately protected.
4. Review every registered child MCP server and its environment variables.
   Optional and remote child MCP servers are disabled by default; enable them
   explicitly with `MCP_ENABLE_OPTIONAL_SERVERS` or `MCP_ENABLE_REMOTE_SERVERS`.
5. Keep `data/`, `.env*`, chat databases, logs, and generated artifacts out of
   the repository.
6. Rotate credentials if they were ever committed, logged, or shared.
7. Before publishing a repository, scan the complete Git history, not only the
   working tree.
8. Keep the application-level login and share-password rate limits enabled, and
   add a distributed proxy/WAF rate limit for multi-instance deployments. Trust
   `x-real-ip` or the **last** `X-Forwarded-For` hop, not the first hop.
9. Do not rely on the legacy `x-chat-password` / `x-chat-username` headers.

Authentication failures use generic responses and are rate-limited by client
address and username. Share passwords are accepted only in request bodies;
they are never read from GET query parameters. Internal bearer tokens are
validated with fixed-length, timing-safe comparisons.

Chat ownership is assigned during SQLite migration. Authenticated chat
lookups require an explicit matching `owner_id`; ownerless legacy rows are not
available through authenticated routes.

The default MCP listener binds to `127.0.0.1`. That is a network boundary, **not
authentication**. Require `MCP_BEARER_TOKEN` even for localhost callers, and do
not expose the listener publicly unless an authenticated, trusted proxy is in
front of it. Keep `MCP_ALLOW_REMOTE_ADMIN=false` unless remote administration is
explicitly required.

Known open issues (11 Sep 2026), including the localhost unauthenticated
session path, XFF rate-limit bypass, and legacy header auth, are tracked in
[`docs/PRODUCTION-AUDIT.md`](./docs/PRODUCTION-AUDIT.md).
