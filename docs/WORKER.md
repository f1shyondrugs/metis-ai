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
whole pool (BUG-C3 partial). There are still no priority classes.

## Known P0 (11 Sep 2026)

`reconcileSubagentParent` currently calls `appendMessage` inside an
`enqueueJob` transaction. SQLite then throws `cannot start a transaction within
a transaction` and the **worker process exits 1**, killing in-flight jobs.
Fix: `appendMessageInTransaction` plus a nesting guard. Details:
[PRODUCTION-AUDIT.md](./PRODUCTION-AUDIT.md) P0-2.

## Resource limits

Units `metis-ai`, `metis-ai-worker`, and `metis-ai-mcp` had no `MemoryMax` /
`TasksMax` at audit time (P1-5). Adding cgroup limits is a deploy change;
apply only with an explicit restart approval.
