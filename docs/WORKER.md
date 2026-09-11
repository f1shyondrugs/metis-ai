# Durable agent worker

The web service accepts durable jobs at `POST /api/runs`. Jobs and checkpoints
live under `CHAT_DATA_DIR` (default: `data/`). The worker processes up to 25
jobs in parallel by default (`AI_CHAT_WORKER_CONCURRENCY`) and recovers stale
`running` jobs after a process restart.

The worker uses the per-user Cursor SDK connections from Settings → Providers,
the same `CHAT_DATA_DIR`, and the agent workspace settings used by the web
service. Run it manually with:

```sh
node node_modules/tsx/dist/cli.mjs worker.ts
```

Production is a systemd unit (`metis-ai-worker`). **Do not stop or restart it**
as a side effect of a test, sandbox, or docs change. Restart only when the
operator explicitly asks.

## Recovery (current)

Stale `running` jobs are reaped with a **15-minute cutoff** and lease-based
`reapExpiredJobLeases` (BUG-C5). Do not reintroduce “requeue every running job”.

One interactive slot is reserved so heavy browser/MCP jobs cannot take the
whole pool. Jobs use priority classes: interactive `100`, interactive-heavy `60`
(parent/subagent or browser-ish mode), background `10`. The reserved slot skips
heavy and background work (BUG-C3).

`reconcileSubagentParent` appends the lifecycle-review message with
`appendMessageInTransaction` inside the enqueue transaction. `transaction()`
nests with SAVEPOINT so a nested writer cannot fatal-exit the worker.
## Resource limits

Units `metis-ai` (2G/512), `metis-ai-worker` (6G/1024), and `metis-ai-mcp`
(1G/256) have `MemoryMax` / `TasksMax` (P1-5). Live since the 11 Sep 2026
16:33 CEST restart.
