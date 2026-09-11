# Production audit — 11 Sep 2026

Read-only audit of the live Metis install. No patch, no commit, no service restart in that audit. This file is the **live open-issue list**. August snapshots under `docs/` are historical.

**Counts:** 3 P0 · 7 P1 · 4 P2 · 4 older items still open · 5 partial · 8 fixed.

**Patch rules:** P0-1 → P0-2 → P0-3 → P1 XFF → P1 legacy-auth. Tests after each P0. No slot-build and no systemd restart without an explicit operator request. Do not stop live Metis processes.

## Now — P0 (~1.5 h including tests)

### P0-1 Security — MCP gateway localhost bypass (~45 min)

- **Finding:** Gateway (root process) accepts **unauthenticated** requests from `127.0.0.1`. `upsert_mcp_server` has no owner check when `userId` is missing. Root spawns stdio children with `entry.command` and `${ENV}` expansion. Other OS users on the host plus CORS `*` plus the server browser allowed to hit localhost → root RCE / token exfil. Repro: session without auth → 200, 107 tools.
- **Files:** `lib/mcp-core/gateway-core.mjs` ~3654–3656, ~3128–3140, ~1038–1044, ~3663–3665
- **Impact:** Root code execution, `MCP_BEARER_TOKEN` leak
- **Fix:** Require bearer even on localhost. Put `upsert` / `set_mcp_server_enabled` / `provision_registry_server` in `PRIVILEGED_TOOLS` and require `userId`. Restrict CORS to the app origin.
- **Also closes:** part of SEC-06 (anonymous tool catalog)

### P0-2 Runtime — nested SQLite transaction kills the worker (~30 min)

- **Finding:** `reconcileSubagentParent` calls `appendMessage` (opens a TX) inside an `enqueueJob` TX → `cannot start a transaction within a transaction` → worker fatal exit 1. All in-flight jobs die (`Unexpected worker child exit`). Lifecycle review is never written.
- **Files:** `worker.ts:278`, `lib/db-jobs.ts:180,241`, `lib/sqlite.ts:650-652`
- **Impact:** Worker down on every subagent completion
- **Fix:** Use `appendMessageInTransaction` (same as `app/api/runs/route.ts:231`). Add a nesting guard (savepoint or hard error) in `transaction()`.

### P0-3 Perf/DoS — share lookup loads every chat blob (~30 min)

- **Finding:** `getChatByShareId` loads **all** chat blobs and parses them synchronously. Unauth `GET /api/share` blocks the event loop (~1.7 s). Five parallel requests made `/api/status` take ~8.2 s instead of ~0.03 s.
- **Files:** `lib/db-store.ts:817-820`, `app/api/share/route.ts:12-21`
- **Impact:** Any anonymous client can stall the app
- **Fix:** `WHERE json_extract(data,'$.share.id')=?` plus an index, or a real `share_id` column.

## Next — P1 security / auth (~25 min)

### P1-1 Rate-limit uses the first XFF hop (~10 min) = SEC-09

- **Files:** `lib/rate-limit.ts:35-36`, nginx `proxy_add_x_forwarded_for`, `app/api/auth/route.ts:20-21`
- **Fix:** Prefer `x-real-ip`, or the **last** XFF hop.

### P1-2 Legacy header auth (~15 min) = SEC-03

- **Files:** `lib/auth.ts:82-89` (`CHAT_PASSWORD` + caller-chosen `x-chat-username`)
- **Fix:** Feature-flag the path off, or pin it to a migration account.

## Later — remaining P1

| ID | Area | Effort | Notes |
| --- | --- | --- | --- |
| P1-3 | Perf | 3–4 h | Chat checkpoint every 1.5 s rewrites full JSON; list SQL does 14× `json_extract` over all blobs (~566 ms), polled every 10 s. Materialize `title, updated, run_status, incognito`; store tool results once; replace poll with SSE. `worker-runner.ts:748-772`, `db-store.ts`, `app-shell.tsx:4944` |
| P1-4 | UI | ~2.5 h | 30× `toLowerCase` TypeError, 3× React #185 on a 237-message chat. Harden calls, virtualize the message list. = BUG-H UI |
| P1-5 | Prod | 20 min | `metis-ai` / `-worker` / `-mcp` have no cgroup `MemoryMax`/`TasksMax`. Worker concurrency 25 × ~4 GB heap. **No restart without explicit approval.** = BUG-H systemd |
| P1-6 | Privacy | 10 min | Incognito filter is a no-op (`db-store.ts:213` vs SELECT). Latent; 0 incognito chats at audit time. = SEC-08 |

## Nice-to-have — P2

| ID | Effort | Fix |
| --- | --- | --- |
| P2-1 Log noise ("Server Reference ID did not match") | 15 min | nginx: block `Next-Action` without a valid origin |
| P2-2 `data/agent-traces` growth | 20 min | 14-day retention + cron |
| P2-3 Touch targets 24–28 px | 1 h | `min-h-11` at `(pointer: coarse)` in `app-shell.tsx` |
| P2-4 Orphan attachments on `/api/runs` 409 | 20 min | Persist attachments in `beforeInsert`, not before enqueue |

## Older items — still open or partial

| ID | Status |
| --- | --- |
| BUG-C3 Heavy jobs starve chats | Partial — one reserved interactive slot (`worker.ts:413-419`); no priority classes |
| BUG-H systemd limits | Open — see P1-5 |
| BUG-H UI blank/stuck | Partial — see P1-4 |
| SEC-03 Legacy `x-chat-password` | Open — see P1-2 |
| SEC-06 Unfiltered tool catalog | Partial — worker manifest filter; anonymous still 107 tools until P0-1 |
| SEC-08 Incognito list SQL | Open — see P1-6 |
| SEC-09 Rate-limit XFF | Open — see P1-1 |
| SEC-10 Shallow redaction | Partial — recursive in `agent-trace.ts` but key/prefix regex only |
| SEC-13 Approval receipts | Partial — not on every internal route |

## Older items — fixed (do not re-open without a new repro)

| ID | Evidence |
| --- | --- |
| BUG-C1 MCP header impersonation | `gateway-core.mjs` HMAC session claims; headers ignored |
| BUG-C2 `call_mcp_tool` child policy | `assertChildMcpGrant` |
| BUG-C4 Browser WS unhandled rejection | `server.mjs` try/catch + `socket.destroy()` |
| BUG-C5 Recovery requeued everything | 15-min cutoff, lease reap |
| BUG-C6 `/api/runs` orphan message | `appendMessageInTransaction` in enqueue TX |
| SEC-01 `approved` as tool argument | server-side `approvedPatterns` only |
| SEC-02 Link-preview SSRF | `fetchWithValidatedRedirects` + bounded body |
| SEC-05 NULL-owner wildcard | migration only; 0 ownerless chats |

`design.md` glassmorphism is **not** the live UI target (no glass/glow).

## Audit gap

Mobile sidebar at 390 px: server browser showed the drawer open. May be a headless artifact. Re-check with real touch/UA before patching.
