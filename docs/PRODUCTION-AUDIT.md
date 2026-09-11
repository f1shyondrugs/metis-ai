# Production audit — 11 Sep 2026

**Live now:** Slot `.next-b` (`BUILD_ID` `jthGBW0h4La8Nws78x3Yv`), units restarted 11 Sep 2026 16:33 CEST. App/worker/MCP `active`. Git HEAD is still `f92d372`; the rest-audit code is in the working tree **and** in the live `.next-b` build (not committed).

**Shipped live:** P0-1, P0-2, P0-3, P1-1, P1-2, P1-3, P1-4, P1-5, P1-6, P2-1, P2-2, P2-3, P2-4, BUG-C3, SEC-10, SEC-13.
**Still open:** git commit of the dirty tree; mobile sidebar 390 px measurement.

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

### P1-3 Perf — chat checkpoint + list SQL

Sidebar list reads `chat_list` (indexed columns, filter in SQL). `upsertMessage` patches `$.messages[n]` with `json_set` / `json_insert` instead of rewriting the full chat blob. Idle `/api/chats` poll is 30 s (10 s while a run is active; skipped when the tab is hidden).
Evidence: `lib/db-store.ts`, `lib/sqlite.ts`, `lib/chat-list-poll.ts`, `tests/production-audit.test.ts`.

### P1-4 UI — toLowerCase TypeError / windowed messages

Call sites stringify before `.toLowerCase()`. Windowed `visibleMessages` caused scrollbar jitter and was reverted; the list renders the loaded page again (older messages still paginate via “Scroll up”).
Evidence: `components/app-shell.tsx`, `components/tool-call-chip.tsx`.

### P1-5 Prod — systemd cgroup limits

Live since 16:33 CEST: `metis-ai` MemoryMax=2G TasksMax=512, `metis-ai-worker` 6G/1024, `metis-ai-mcp` 1G/256.

### P1-6 Incognito list SQL = SEC-08

`listChatsForUser` selects `$.incognito`. Incognito chats stay out of the normal list.

### P2-1 Prod — nginx Next-Action without origin

`Next-Action` without a same-host Origin/Referer returns 403. Rule is on `metis-ai.f1shy312.com` and `ai.f1shy312.com`. GET `/api/status` stays 200.

### P2-2 Prod — agent-trace retention

Trace dirs older than 14 days are removed in batches of 32, at most once per hour.
Evidence: `lib/agent-trace.ts`, `tests/agent-trace.test.ts`.

### P2-3 UI — 44 px touch targets

Icon/control buttons use `max-md:min-h-11 max-md:min-w-11`.

### P2-4 Orphan attachments

`/api/runs` and `/api/chat` persist attachments inside `beforeInsert`, so a 409 does not leave files.

### BUG-C3 Runtime — priority classes

Jobs: interactive `100`, interactive-heavy `60` (parent/subagent or browser-ish mode), background `10`. The reserved interactive slot skips heavy and background work.
Evidence: `lib/db-jobs.ts`, `tests/recovery.test.ts`.

### SEC-10 Privacy — nested redaction

`redactSensitiveData` walks objects/arrays and redacts key names plus secret-shaped values (PEM, Slack, AWS, JWT, long mixed tokens). Remote audit uses the same helper.
Evidence: `lib/agent-trace.ts`, `lib/remote-clients.ts`.

### SEC-13 Security — internal mutating routes require the active run lease

Internal mutating MCP/browser/remote-client routes reject requests without a valid run lease even when the bearer token is present.
Evidence: `app/api/internal/*/route.ts`, `tests/production-audit.test.ts`.

## Still open

| ID | Area | Effort | Notes |
| --- | --- | --- | --- |
| GIT | Ops | 5 min | 31 dirty files not committed; live slot already contains them |
| UI | Mobile | 20 min | Sidebar at 390 px: re-check with real touch/UA |

## Older items — fixed (do not re-open without a new repro)

BUG-C1, C2, C4, C5, C6, SEC-01, SEC-02, SEC-05, plus P0-1/2/3, SEC-03, SEC-06 anonymous catalog (auth required), SEC-08, SEC-09.

`design.md` glassmorphism is **not** the live UI target.
