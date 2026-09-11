# Metis AI documentation

Canonical docs live here. Root keeps only GitHub/agent entry points: `README.md`, `LICENSE`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`.

**Last review:** 11 Sep 2026. Open production issues are in [PRODUCTION-AUDIT.md](./PRODUCTION-AUDIT.md). Do not stop live `metis-ai` / worker / MCP units as a side effect of tests.

## Start here

| Doc | What it is |
| --- | --- |
| [PRODUCTION-AUDIT.md](./PRODUCTION-AUDIT.md) | Current P0/P1/P2 and leftover August findings (11 Sep 2026) |
| [BUG_PRIORITY.md](./BUG_PRIORITY.md) | Priority list with **fixed vs open** status |
| [SECURITY.md](../SECURITY.md) | Public-deployment checklist and vulnerability reporting |
| [REMOTE-CLIENT-SECURITY.md](./REMOTE-CLIENT-SECURITY.md) | Remote-client permission model |
| [DEPLOY.md](./DEPLOY.md) | Deploy notes (secrets stay out of git) |
| [WORKER.md](./WORKER.md) | Durable worker, concurrency, recovery |
| [RELEASE-TESTING.md](./RELEASE-TESTING.md) | Release and upgrade checks |

## Architecture (historical + current)

| Doc | Status |
| --- | --- |
| [METIS_ARCHITECTURE_AUDIT.md](./METIS_ARCHITECTURE_AUDIT.md) | Snapshot 21 Aug 2026 — do not treat as live open-bug list |
| [METIS_MODERNIZATION_PLAN.md](./METIS_MODERNIZATION_PLAN.md) | Snapshot 21 Aug 2026 — sequencing still useful |
| [FINAL_STABILITY_REPORT.md](./FINAL_STABILITY_REPORT.md) | Snapshot 20 Aug 2026 — what that wave actually shipped |
| [PORT-PLAN-t3-architecture.md](./PORT-PLAN-t3-architecture.md) | t3 architecture port plan |
| [PORT-SPEC-t3-full.md](./PORT-SPEC-t3-full.md) | t3 port spec |
| [BUILD-SPEC-runtime-modes.md](./BUILD-SPEC-runtime-modes.md) | Runtime-mode build spec |

## Design

| Doc | Status |
| --- | --- |
| [design.md](./design.md) | **Superseded.** Glass/glow is not the live UI target. |

## Package docs (stay next to code)

- [`packages/mcp-gateway/README.md`](../packages/mcp-gateway/README.md) — gateway module boundary. Default listen port in `.env.example` is `8787`; a live host may bind a different `MCP_PORT`.
- [`deploy/nginx/README.md`](../deploy/nginx/README.md) — nginx template notes.
