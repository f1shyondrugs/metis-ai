# T3-Port Vollarchitektur — Master Spec (2026-08-27)

Ziel: Metis' Agent-Stack wird architektonisch zu t3 Code portiert — **mit unserer UI und unseren Features**.
Referenz-Clone: `/home/samuel/t3code` (MIT). Nur lesen, nie ändern.

## Zustand
- Branch: `feat/runtime-modes` (Phase 1 RuntimeModes+Approvals deployed 2026-08-26, E2E verifiziert)
- Monolith: `lib/providers/runner.ts` (2709 Zeilen, 4 divergente Provider-Pfade)
- MCP-Injektion für CLI-Provider funktioniert, aber: `npx -y mcp-remote` HTTP-Bridge (langsam, pro Session) + `alwaysLoad: true` (alle ~77 Tool-Schemas IMMER im Context)
- Kein kanonisches Event-Modell, keine Timeline-UI, kein Context-Scoping pro Chat/Projekt

## Zielarchitektur (t3-Konzept, Metis-Stack: Next.js + SQLite + Job-Queue, KEIN Effect)

### 1. Provider-Adapter-Layer (WS1)
- `lib/providers/adapters/` — pro Provider EIN Adapter: `ai-sdk.ts`, `codex.ts`, `claude.ts`, `antigravity.ts`, (+ `cursor.ts` falls vorhanden)
- Jeder Adapter implementiert Contract `ProviderAdapter` (startSession/sendTurn/interrupt/respondToRequest/readThread/rollbackThread/streamEvents) — als plain async/await, Effect bleibt draußen
- `lib/providers/service.ts` = ProviderService: routed by providerKey, Orchestrierung kennt Provider nicht namentlich
- Kanonische Events: `lib/runtime/events.ts` — `session.started`, `turn.started`, `item.tool.run`, `content.delta`, `request.opened`, `turn.completed`, `turn.failed` (aus agent-rework contracts.ts ableiten, Cherry-Pick-Basis)
- Jeder Adapter emittiert NUR noch kanonische Events → SSE

### 2. Native HTTP-MCP mit Session-Tokens (WS1, t3 McpHttpServer-Pattern)
- Metis-Gateway (`packages/mcp-gateway/index.mjs`) bekommt Streamable-HTTP-Transport auf `127.0.0.1:<port>/mcp` im Metis-Serverprozess
- `McpSessionRegistry`: pro (chatId,userId) ein Bearer-Token, Tool-Visibility + Mode-Policy werden AUS DEM TOKEN-Kontext resolves (nicht mehr per Env-Var-Kopie pro Spawn)
- Codex-Adapter: native HTTP-MCP via `config.mcp_servers.metis_ai = { url, bearer_token_env_var }` (kein mcp-remote!)
- Claude-Adapter: `mcpServers: { metis_ai: { type: "http", url, headers } }` (kein alwaysLoad)
- Ergebnis: keine npx-Downloads, keine stdio-Env-Kopie, Token-Revocation bei Chat-Ende, Tools lazy sichtbar

### 3. Context-System (WS2) — "er weiß nicht mehr alles"
- **Per-Chat Context Scope**: jeder Chat hat eigenen Kontext (Notes, Referenzen, Memory) — getrennt von anderen Chats
- **Projekt-Context**: `projectContextBlock` wird erweitert: Projekt = Quelle für Tools/Notes/AGENTS-Datei-Pfad; Chats ohne Projekt bekommen KEIN Projekt-Wissen
- **Context Pressure**: `context-window.ts` Ratios in jedem Adapter nutzen; bei ≥80% → Auto-Compaction via `lib/compression/`
- Prompt-Assembly neu: `lib/providers/prompt-context.ts` — baut Provider-Prompt AUS Chat+Projekt+Scope, runner.ts ruft nur noch `buildProviderPrompt(chatContext)`
- Explicit > Pinned > Projekt > Global. Nicht-gewusstes bleibt weg — Agent muss Tools nutzen um mehr zu wissen

### 4. Timeline-UI (WS3) — unsere Features, t3-Feeling
- SSE-Kanal `/api/runtime/events` (bestehende stream-route erweitern) liefert kanonische Events
- `components/timeline/` (aus agent-rework cherry-picken): ToolRunCard (kompakte Tool-Chips), ReasoningBlock, MessagesTimeline, ContextMeter, ApprovalPanel (bestehend), QuestionModal
- Performance: Event-Batching (requestAnimationFrame), keine Re-Renders ganze Liste, virtuelles Scrollen bei >100 Items
- Tool-Anzeigen-Fix: korrektes Mapping item.tool → Anzeige (aktuell "UI zeigt falsch")

## Nicht-Portieren (bewusst)
- Effect-TS RPC/WebSocket, Event-Sourcing-Engine (Decider/Projector), t3 Connect/Relay
- Checkpointing = Phase 4 (nach diesem Port), außer die Events präparieren es schon

## Verify-Standard (MUSS)
1. `pnpm typecheck` grün
2. `pnpm test` grün (bestehende Tests ERWEITERN, nicht löschen)
3. Jede neue Datei < 800 Zeilen, Adapter-Dateien peer-reviewed
4. E2E nach Merge: GLM-Chat mit Tools, Codex-Chat mit nativem MCP ( approval-required Mode zeigt Panel), Context-Meter sichtbar, Chat-Isolation (Chat A weiß nichts von Chat B)

## Workstream-Dateien (Konflikt-Vermeidung)
- WS1: `lib/providers/adapters/*`, `lib/providers/service.ts`, `lib/runtime/*`, `packages/mcp-gateway/*`, `lib/mcp-*.ts`, runner.ts-Split
- WS2: `lib/providers/prompt-context.ts`, `lib/context-scope.ts`, `lib/compression/*`, `lib/projects.ts`, `lib/shared-context.ts` — NICHT runner.ts direkt
- WS3: `components/timeline/*`, `app/api/runtime/*`, `hooks/use-timeline.ts` — NICHT runner.ts
- Integration (Call-Sites im Runner, Wiring, Merge-Reihenfolge): nur Orchestrator
