# Metis AI bug priority

**Authoritative open list:** [PRODUCTION-AUDIT.md](./PRODUCTION-AUDIT.md) (11 Sep 2026).

This file tracks severity buckets. August 20 items that were fixed stay here as closed so they are not re-filed from old reports.

## Critical (open)

- MCP gateway on localhost accepts unauthenticated sessions; `upsert_mcp_server` / spawn path can run as root without `userId` (P0-1).
- Nested SQLite transaction in `reconcileSubagentParent` fatal-exits the worker (P0-2).
- `getChatByShareId` scans every chat blob; unauth `/api/share` can stall the event loop (P0-3).

## High (open)

- Rate limit trusts the first `X-Forwarded-For` hop (SEC-09 / P1-1).
- Legacy `x-chat-password` + caller-chosen `x-chat-username` impersonation path (SEC-03 / P1-2).
- Full-JSON chat checkpoints every 1.5 s and list queries over every blob (P1-3).
- Production `toLowerCase` TypeError and React #185 on long chats (P1-4).
- systemd units have no cgroup memory/CPU/task limits (P1-5).
- Incognito filter is a no-op in list SQL (SEC-08 / P1-6).
- Heavy jobs still share the pool; only one reserved interactive slot (BUG-C3 partial).

## Medium (open)

- Redaction is recursive but still key/prefix regex only (SEC-10).
- Approval receipts are not on every internal route (SEC-13).
- `/api/runs` can leave attachments on disk after a 409 (P2-4).
- Agent-trace directory has no retention (P2-2).

## Closed (Aug–Sep 2026) — keep closed unless newly reproduced

- MCP bearer accepted caller-supplied user/chat/job headers (BUG-C1).
- `call_mcp_tool` skipped child-tool policy (BUG-C2).
- Browser WebSocket setup unhandled rejection (BUG-C4).
- Worker recovery requeued every running job (BUG-C5).
- `/api/runs` orphan user message before enqueue failure (BUG-C6).
- `approved` accepted as a tool argument (SEC-01).
- Link-preview SSRF (SEC-02).
- `owner_id IS NULL` wildcard on authenticated lookups (SEC-05).
