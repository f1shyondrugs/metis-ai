# Metis AI Final Stability Report

> **Status:** Snapshot **20 Aug 2026** (what that wave shipped). Current open issues: [PRODUCTION-AUDIT.md](./PRODUCTION-AUDIT.md).

Date: August 20, 2026

## Fixed Bugs

- Made run submission atomic so `/api/runs` cannot orphan user messages.
- Added bounded worker concurrency defaults, interactive priority scheduling,
  one reserved interactive slot, stale-age recovery, corrupt-row handling, and
  child-spawn failure handling.
- Added terminal-state guards for MCP question completion races.
- Enforced OAuth > account > API key connection precedence.
- Preserved existing credentials during OAuth reconnect and restored pending
  connection visibility after failed flows.
- Rejected incomplete account and provider credentials before execution.
- Removed caller-supplied account context from external MCP HTTP sessions.
- Applied child MCP tool policy checks and made capability provisioning opt-in.
- Added browser action, DNS, metadata, screenshot, upload containment, and
  persistent-session cleanup limits.
- Added browser WebSocket rejection handling and honored realtime/FPS settings.
- Fixed stale chat queue revalidation, recoverable initial chat/model loading,
  and terminal stream refresh behavior.
- Added worker heartbeat health reporting.
- Unified production slot builds and installer/systemd resource limits.
- Installed and enabled the persistent MCP service on port `8800`.
- Added model-aware Codex reasoning effort forwarding through the official SDK.
- Suppressed Antigravity effort flags for Claude model families that reject them.
- Added structured context-compaction run events with a visible chat status row.
- Switched automatic compaction pressure to 80% of the effective input budget.
- Preserved catalog model parameters when provider discovery refreshes live models.
- Excluded runtime-generated provider session trees from repository typechecking.

## Tests Executed

- `pnpm test`: passed, 126 tests total.
- Focused queue/provider/browser/recovery suites: passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with 0 errors and 16 existing warnings.
- `pnpm run audit:capabilities`: passed for 27 provider/model capability
  entries.
- `bash -n` deployment scripts: passed.
- `node --check` server and MCP gateway: passed.
- Production build: passed in inactive slot `.next-a` with
  `BUILD_ID=DICTWttH-_58qFpGnw1wP`.
- SQLite `PRAGMA integrity_check`: `ok` in the existing deployment checks.
- Live browser check: sign-in screen rendered at `http://127.0.0.1:4000/`
  without a framework error overlay; the expected unauthenticated API request
  returned `401`.
- Live HTTP root: `200`.
- Live `/api/status`: `200`, worker heartbeat healthy.
- Live MCP `/health`: `200`.
- Invalid MCP authorization: `401`.
- `metis-ai.service`, `metis-ai-worker.service`, and
  `metis-ai-mcp.service`: active. Services were not restarted for this build.

## Remaining Issues

- No provider connections are configured in the current deployment, so real
  model chat, OAuth callback/refresh, and provider-specific API tests could not
  be executed with real credentials.
- Full authenticated chat streaming, multi-provider execution, and external
  OAuth flows remain credential-dependent acceptance gaps.
- Lint retains 16 non-blocking hook/image warnings in pre-existing UI code.

## Production Status

The production runtime, inactive build slot, systemd services, worker
heartbeat, MCP health, HTTP health, database integrity, and unauthenticated
browser workflow are verified. The new build is staged but not live because no
service restart was authorized. Full platform production acceptance is not
complete until provider credentials are configured and authenticated
chat/OAuth/provider smoke tests are run.
