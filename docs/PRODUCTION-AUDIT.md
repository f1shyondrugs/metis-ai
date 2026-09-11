# Production audit — 11 Sep 2026

Code patches landed 11 Sep 2026. Live units run `9d6e9d0` until the next approved slot deploy.

**Shipped in git:** P0-1, P0-2, P0-3, P1-1, P1-2, P1-6, P2-4, **P1-3**.
**Still open:** P1-4, P1-5 (needs restart), P2-1, P2-2, P2-3, BUG-C3 priority classes, SEC-10, SEC-13.

## Shipped

### P0-1 Security — MCP gateway localhost bypass

Unauthenticated 127.0.0.1 sessions are rejected. `upsert_mcp_server` / `set_mcp_server_enabled` / `provision_registry_server` are privileged and require `userId`. CORS is origin-allowlisted, not `*`.
Evidence: `lib/mcp-core/http-auth.mjs`, `tests/mcp-http-auth.test.ts`.

### P0-2 Runtime — nested SQLite transaction

`reconcileSubagentParent` uses `appendMessageInTransaction`. `transaction()` nests with SAVEPOINT.
Evidence: `worker.ts`, `lib/sqlite.ts`, `tests/production-audit.test.ts`.

### P0-3 Perf/DoS — share lookup

`getChatByShareId` / `cloneChatByShareId` use `WHERE json_extract(data,'$.share.id')=?` plus index `chats_share_id`.
Evidence: `lib/db-store.ts`, `lib/sqlite.ts`.

### P1-1 Rate-limit XFF = SEC-09

`requestClientAddress` prefers `x-real-ip`, else the **last** XFF hop.

### P1-2 Legacy header auth = SEC-03

`x-chat-password` / `x-chat-username` is off unless `CHAT_LEGACY_HEADER_AUTH=true`.

### P1-6 Incognito list SQL = SEC-08

`listChatsForUser` selects `$.incognito`. Incognito chats stay out of the normal list.

### P2-4 Orphan attachments

`/api/runs` and `/api/chat` persist attachments inside `beforeInsert`, so a 409 does not leave files.

### P1-3 Perf — chat checkpoint + list SQL

Sidebar list reads `chat_list` (indexed columns, filter in SQL). `upsertMessage` patches `$.messages[n]` with `json_set` / `json_insert` instead of rewriting the full chat blob. Idle `/api/chats` poll is 30 s (10 s while a run is active; skipped when the tab is hidden).
Evidence: `lib/db-store.ts`, `lib/sqlite.ts`, `lib/chat-list-poll.ts`, `tests/production-audit.test.ts`.

## Still open

| ID | Area | Effort | Notes |
| --- | --- | --- | --- |
| P1-4 | UI | ~2.5 h | `toLowerCase` TypeError / React #185; virtualize message list |
| P1-5 | Prod | 20 min | systemd `MemoryMax`/`TasksMax` — **needs explicit restart** |
| P2-1 | Prod | 15 min | nginx: block `Next-Action` without origin |
| P2-2 | Prod | 20 min | agent-trace retention |
| P2-3 | UI | 1 h | 44 px touch targets |
| BUG-C3 | Runtime | — | reserved interactive slot exists; no priority classes |
| SEC-10 | Privacy | — | redaction still key/prefix regex |
| SEC-13 | Security | — | approval receipts not on every internal route |

## Older items — fixed (do not re-open without a new repro)

BUG-C1, C2, C4, C5, C6, SEC-01, SEC-02, SEC-05, plus P0-1/2/3, SEC-03, SEC-06 anonymous catalog (auth required), SEC-08, SEC-09.

`design.md` glassmorphism is **not** the live UI target.

## Audit gap

Mobile sidebar at 390 px: re-check with real touch/UA before patching.
