# Metis AI bug priority

**Authoritative list:** [PRODUCTION-AUDIT.md](./PRODUCTION-AUDIT.md) (11 Sep 2026).

Live: Slot `.next-b`, units restarted 16:33 CEST. Rest-audit code is live and uncommitted.

## Critical (open)

None.

## High (open)

None in runtime. Remaining ops: commit the dirty tree.

## Medium (open)

- Mobile sidebar at 390 px not re-measured after the UI deploy.

## Closed (Aug–Sep 2026) — keep closed unless newly reproduced

- MCP gateway localhost unauthenticated sessions (P0-1).
- Nested SQLite TX killing the worker (P0-2).
- `getChatByShareId` full-table scan (P0-3).
- Rate limit first XFF hop (SEC-09 / P1-1).
- Legacy `x-chat-password` impersonation path (SEC-03 / P1-2).
- Incognito filter no-op in list SQL (SEC-08 / P1-6).
- `/api/runs` orphan attachments on 409 (P2-4).
- Full-JSON chat checkpoints and 14× `json_extract` list SQL (P1-3).
- Production `toLowerCase` TypeError / React #185 on long chats (P1-4).
- systemd cgroup memory/CPU/task limits (P1-5).
- nginx `Next-Action` without origin (P2-1).
- Agent-trace directory retention (P2-2).
- Touch targets 24–28 px (P2-3).
- Heavy jobs sharing the pool without priority classes (BUG-C3).
- Redaction key/prefix regex only (SEC-10).
- Approval receipts missing on internal mutating routes (SEC-13).
- MCP bearer accepted caller-supplied user/chat/job headers (BUG-C1).
- `call_mcp_tool` skipped child-tool policy (BUG-C2).
- Browser WebSocket setup unhandled rejection (BUG-C4).
- Worker recovery requeued every running job (BUG-C5).
- `/api/runs` orphan user message before enqueue failure (BUG-C6).
- `approved` accepted as a tool argument (SEC-01).
- Link-preview SSRF (SEC-02).
- `owner_id IS NULL` wildcard on authenticated lookups (SEC-05).
