# T3-Code-Architektur-Port: Plan & Analyse (2026-08-25)

> Quelle: github.com/pingdotgg/t3code (MIT-Lizenz, Theo Browne). Lokaler Clone: `/home/samuel/t3code`.
> Ziel: Metis' größte Schwachstellen (anfällige Provider-Paths, kein echtes Approval-Gating, kein Plan-Mode-Enforcement, kein Checkpointing) durch t3's bewährte Architektur ersetzen.

## 1. Warum unser System anfällig ist (Ist-Zustand Metis)

| Problem | Metis heute | t3 Code |
|---|---|---|
| **Runtime-Modes** | GAR KEINE. `runner.ts:1390` hardcoded `approvalPolicy: "never"`, `sandboxMode: "workspace-write"` (Codex); `runner.ts:1511` hardcoded `permissionMode: "acceptEdits"` (Claude). Agent macht immer alles. | 4-stufiger `RuntimeMode` pro Thread: `approval-required` → `auto-accept-edits` → `auto` → `full-access`, pro Provider gemappt |
| **Plan Mode** | `lib/modes.ts` "plan" = nur Tool-Kategorie-Filter (read/browser/plan/memory/subagent). Kein Protokoll, kein Enforcement auf Provider-Ebene, kein `request_user_input`. | `ProviderInteractionMode` (`default`/`plan`) GETRENNT vom RuntimeMode. Codex: `collaboration_mode` + developer_instructions mit striktem 3-Phasen-Plan-Protokoll (explore-first, intent-chat, implementation-chat, `<proposed_plan>`-Block). Nicht-mutierende Exploration erlaubt, Mutation verboten. |
| **Approvals** | Nicht existent. Kein `request.opened`-Event, kein UI-Panel, kein `respondToRequest`. | Vollständiger Flow: `thread.approval.respond` Command, `ProviderApprovalDecision` (`accept`/`acceptForSession`/`acceptAlways`/`decline`/`cancel`), `ComposerPendingApprovalPanel`, Flush des Assistant-Buffers an Request-Grenzen |
| **User-Input-Elicititation** | Nur bei OAuth/Keys. | `request_user_input` als Tool: strukturierte Fragen mit Optionen (`UserInputQuestionPayload`: options, isMultiSelect, allowCustomInput) → `QuestionModal` |
| **Provider-Architektur** | Monolithisch: `runner.ts` (1981 Zeilen) mit 4 divergenten Pfaden (`runAiSdk`/`runCodex`/`runClaude`/`runAntigravity`), jede Querschnittsfunktion (Telemetry, Prompts, Command-Parsing) muss 4x gespiegelt werden — dokumentierte Fehlerquelle. | `ProviderAdapter`-Interface (12 Operationen), `ProviderInstanceRegistry` (Config) vs `ProviderAdapterRegistry` (live Prozesse), Orchestrierung kennt den Provider nicht |
| **Checkpointing** | Nicht existent. Agent zerstört Code → kein Revert. | Pro Turn Git-Ref-Checkpoints (`CheckpointStore` via `VcsCheckpointOps`), Baseline bei Turn-Start, Capture bei Turn-Ende, Revert von Workspace UND Provider-Konversation (`rollbackThread`) |
| **Event-Modell** | `chats.data` JSON-Blobs, angehangene Messages. | Kanonische Event-Timeline (`ProviderRuntimeEvent`), Event-Sourcing mit Decider/Projector, idempotente Command-Receipts |
| **Interrupt/Session-Kontrolle** | Partiell (AbortSignal). | `thread.turn.interrupt`, `thread.session.stop` als erstklassige Commands |

## 2. Was wir NICHT übernehmen (bewusste Abgrenzung)

- **Effect RPC/WebSocket-Layer**: t3 nutzt Effect-TS durchgängig (RpcServer, Schemas, Layers). Metis ist Next.js + SQLite + Job-Queue — wir portieren die **Konzepte und Contracts**, nicht das Framework. Eine Effect-Rewrite wäre Wochenarbeit ohne Stabilitätsgewinn für Single-User.
- **Event-Sourcing-Engine (Decider/Projector/Single-Writer-Fiber)**: Overkill für Metis' Job-Queue. Wir übernehmen nur das **kanonische Event-Modell** (Timeline), nicht die persistente Command/Event-Log-Maschinerie.
- **t3 Connect / Relay / Multi-Environment-Auth**: Metis ist single-user hinter Cloudflare-Auth.
- **Buffered Assistant Delivery** (24k-Char-Buffer):nice-to-have, später.

## 3. Der agent-rework-Branch ist 60% des Weges

`agent-rework` (3 Commits, 2026-08-2x, NIE deployed) enthält bereits:
- `lib/runtime/contracts.ts` — kanonische Events (`session.started`, `turn.started`, `turn.plan.updated`, `item.*`, `content.delta`, `request.opened`, ...), `ApprovalRequestPayload`, `UserInputQuestionPayload`, `DiffFileChange` ✅
- `lib/runtime/driver-registry.ts` + 7 Driver-Skelette (dünn: Codex-Driver ist 89 Zeilen, hardcoded `approvalPolicy: "never"`) ⚠️
- `lib/runtime/event-bus.ts`, `timeline-reducer.ts` (269 Zeilen, gruppiert Tool-Runs) ✅
- `lib/runtime/mcp-gateway.ts` (372 Zeilen, session-basiert) ⚠️
- `app/api/runtime/approval/route.ts` + `question/route.ts` + `stream/route.ts` ✅ Skelette
- `components/timeline/`: `ApprovalPanel`, `QuestionModal`, `ProposedPlanCard`, `ToolRunCard`, `StyledDiffView`, `MessagesTimeline`, `ReasoningBlock`, `ContextMeter` ✅ UI fertig
- `tests/runtime/runtime-architecture.test.ts` ✅

**Achtung**: Branch basiert auf 5380da7 (VOR Upstream-Sync 1ffa691). Merge nach stable/overall = Konflikte in runner.ts/worker-runner.ts/app-shell.tsx wahrscheinlich. Strategie: Dateien aus agent-rework CHERRY-PICKEN (sind fast alle neue Files → wenig Konflikt), NICHT branch-mergen.

## 4. Port-Phasen

### Phase 1 — Runtime Modes + Approval Flow (größter Stabilitätsgewinn)
1. `RuntimeMode` = `approval-required | auto-accept-edits | auto | full-access` (Default: `full-access` — Samuel's Workflow) pro Chat, persisted in Chat-Row, per API setzbar.
2. Provider-Mapping-Tabelle (aus t3 `CodexSessionRuntime.ts:495-518` + `ClaudeAdapter.ts:4284`):
   - **Codex** (`@openai/codex-sdk` 0.147.0, `startThread`): `approval-required` → `{approvalPolicy: "untrusted", sandbox: "read-only"}`; `auto-accept-edits` → `{on-request, workspace-write}`; `auto` → `{on-request, workspace-write, approvalsReviewer: auto}`; `full-access` → `{never, danger-full-access}`
   - **Claude** (`@anthropic-ai/claude-agent-sdk` 0.3.223): `approval-required` → `permissionMode: "default"` + `canUseTool`-Callback → `request.opened`-Event; `auto-accept-edits` → `"acceptEdits"`; `auto`/`full-access` → `"bypassPermissions"`
   - **AI-SDK/GLM** (runAiSdk): Mode bleibt Tool-Kategorie-Policy (MCP_MODE_POLICY), zusätzlich `terminal`-Tools auf "approval-required" via `request.opened` führen (Gateway-seitig schon vorbereitet durch assertModePolicy).
3. Approval-Flow: Driver emit `request.opened` → Event-Bus → SSE `/api/runtime/stream` → `ApprovalPanel.tsx` (aus agent-rework) → `POST /api/runtime/approval` `{requestId, decision}` → Driver `respondToRequest`.
4. UI: RuntimeMode-Switcher im Composer (kompakt, kein neuer Button-Wahn — Dropdown neben Model-Picker gemäß metis-ui-contract).

### Phase 2 — Echter Plan Mode
1. `ProviderInteractionMode` (`default`/`plan`) pro Chat, UNABHÄNGIG von RuntimeMode (Plan + full-access = valid: Agent plant, darf lesen/exportieren, keine Mutation).
2. Codex: `collaboration_mode` via developer_instructions — t3's `codexPlanModeDeveloperInstructions` (MIT) 1:1 übernehmen, "T3 Code"→"Metis", `<proposed_plan>`-Parsing → `ProposedPlanCard.tsx` (agent-rework).
3. `request_user_input`-Tool (strukturierte Fragen) → `QuestionModal.tsx` (agent-rework) → `POST /api/runtime/question`.
4. GLM/AI-SDK-Pfad: Plan-Mode = mode "plan" (bestehend) + t3-Plan-Instruktionen als System-Prompt-Zusatz + striktes Server-Policy (MCP_MODE_POLICY hat's schon).
5. Plan→Build-Handoff: "Build plan"-Button am ProposedPlanCard wechselt interactionMode→default und sendet Plan als Turn (bestehendes Konzept, verdrahten).

### Phase 3 — Kanonische Timeline (Vereinheitlichung)
1. Alle 4 Provider-Paths emitten kanonische Events (contracts.ts) statt proprietärer Message-Appends.
2. `timeline-reducer` wird Source-of-Truth für Chat-Rendering; `chats.data` bleibt Persistenz (rückwärtskompatibel), wird aber aus Events abgeleitet.
3. ToolRunCard-Gruppierung (t3-Feeling: kompakte Tool-Chips statt endloser Logs).

### Phase 4 — Turn-Checkpointing
1. `CheckpointStore`: bei Turn-Start Baseline-Git-Ref, bei Turn-Ende Capture-Ref (hidden refs `refs/metis/checkpoints/<chatId>/<turnId>`), Workspace muss Git-Repo sein (auto-init wenn nötig).
2. Diff-Anzeige pro Turn (`StyledDiffView.tsx` aus agent-rework), Revert = `git reset` auf Baseline + `rollbackThread` beim Provider.
3. UI: Turn-Karte mit Diff-Stat + Revert-Button.

## 5. Verify-Standard pro Phase

- `npx tsc --noEmit` + `pnpm test` grün
- Manual-Deploy-Flow (kill worker → build → restart beide Units → BUILD_ID + ActiveEnterTimestamp prüfen)
- E2E: Chat anlegen, Turn mit jedem RuntimeMode (Codex-Pfad: approval-required muss ApprovalPanel zeigen und auf Entscheidung warten — NIEMALS automatisch weiterlaufen), Plan-Mode-Turn darf keine Datei ändern (verify via git status), Checkpoint-Revert stellt Datei-Inhalt wieder her.
- Telegram-Formatierung unverändert (stripInternalBlocks für neue Blöcke erweitern: ```plan → ProposedPlanCard nur Web).

## 6. Quellen-Dateien (t3code-Clone)

| t3-Datei | Zweck |
|---|---|
| `packages/contracts/src/orchestration.ts:120-160` | RuntimeMode, InteractionMode, ApprovalDecision/Option, Limits |
| `apps/server/src/provider/Layers/CodexSessionRuntime.ts:488-630` | runtimeModeToThreadConfig + buildTurnStartParams (Codex-Mapping) |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts:4284-4290` | runtimeMode→PermissionMode (Claude-Mapping) |
| `apps/server/src/provider/CodexDeveloperInstructions.ts` | Plan-Mode + Default-Mode Instruktionen (MIT, anpassen) |
| `apps/server/src/provider/Services/ProviderAdapter.ts` | Adapter-Interface (12 Ops) |
| `apps/server/src/checkpointing/*` | CheckpointStore/DiffQuery (Phase 4) |
| `docs/internals/overview.md` + `providers.md` | Architektur-Doku |
