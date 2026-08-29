# BUILD SPEC — Phase 1: Runtime Modes + Approval Flow (t3-Port)

> Parent plan: `docs/PORT-PLAN-t3-architecture.md`. Quelle t3code (MIT): `github.com/pingdotgg/t3code`.
> Ziel: 4-stufige RuntimeModes pro Chat, gemappt auf alle 3 Provider-Paths (Codex-SDK, Claude-SDK, AI-SDK/GLM), plus interaktiver Approval-Flow im Claude- und GLM-Pfad.
> Repo: `/home/samuel/metis-ai`, Branch: `stable/overall` (darauf aufbauen, neuer Feature-Branch `feat/runtime-modes`).

## Verbindliche Regeln

- UI-Standard: monochrom, keine Gradients/Emojis, keine neuen Top-Level-Buttons. RuntimeMode-Switcher gehört in die bestehenden Composer-Controls (dort wo auch der Mode-Switcher ist).
- AGENTS.md im Repo beachten (Provider-Contract: kein Hardcoden von Model-Capabilities).
- Alle bestehenden Tests müssen grün bleiben (`npx tsc --noEmit`, `pnpm test`).
- Keine Einbindung von Effect-RPC — Konzepte portieren, nicht das Framework.

## Teil A — RuntimeMode-Typ + Persistenz + Provider-Mapping

### A1. Neue Datei `lib/runtime-mode.ts`
```ts
export const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export function normalizeRuntimeMode(value: unknown): RuntimeMode {
  return typeof value === "string" && (RUNTIME_MODES as readonly string[]).includes(value)
    ? (value as RuntimeMode)
    : DEFAULT_RUNTIME_MODE;
}

export function runtimeModeForChat(chat: { runtimeMode?: unknown }): RuntimeMode {
  return normalizeRuntimeMode(chat.runtimeMode);
}

// Codex-SDK (@openai/codex-sdk 0.147.0): ThreadOptions.sandboxMode/approvalPolicy
export const RUNTIME_MODE_TO_CODEX: Record<RuntimeMode, {
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
}> = {
  "approval-required": { sandboxMode: "read-only", approvalPolicy: "untrusted" },
  "auto-accept-edits": { sandboxMode: "workspace-write", approvalPolicy: "on-request" },
  "auto": { sandboxMode: "workspace-write", approvalPolicy: "on-request" },
  "full-access": { sandboxMode: "danger-full-access", approvalPolicy: "never" },
};

// Claude Agent SDK (@anthropic-ai/claude-agent-sdk 0.3.223): Options.permissionMode
// 'default' = prompts via canUseTool; 'acceptEdits'; 'bypassPermissions' (needs allowDangerouslySkipPermissions:true); 'auto' exists in SDK but is classifier-based.
export const RUNTIME_MODE_TO_CLAUDE_PERMISSION: Record<RuntimeMode, {
  permissionMode: "default" | "acceptEdits" | "bypassPermissions";
  canUseToolRequired: boolean;
}> = {
  "approval-required": { permissionMode: "default", canUseToolRequired: true },
  "auto-accept-edits": { permissionMode: "acceptEdits", canUseToolRequired: false },
  "auto": { permissionMode: "acceptEdits", canUseToolRequired: false },
  "full-access": { permissionMode: "bypassPermissions", canUseToolRequired: false },
};
```

### A2. Chat-Typ + Persistenz
- `lib/store.ts` Chat-Typ (~Zeile 391): `runtimeMode?: string;` hinzufügen (Doku-Kommentar: RuntimeMode, siehe lib/runtime-mode.ts).
- `lib/db-store.ts` updateChat-Patch-Pfad (~Zeile 514-556, dort wo modelId gepatcht wird): `runtimeMode` analog behandeln (`patch.runtimeMode === null → delete`, sonst trim/validate via normalizeRuntimeMode → nur gültige Werte speichern, ungültig → ignorieren).
- `lib/db-jobs.ts`: Job-Kontext muss runtimeMode an Provider-Runner weiterreichen — in `runAlternativeProviderJob`/`runJobById` den Chat lesen (passiert schon via `getChat`) und `context.chat.runtimeMode` nutzen.

### A3. Provider-Runner-Anbindung
- `lib/providers/runner.ts` `runCodex` (~Zeile 1385-1392): hardcoded `sandboxMode: "workspace-write"`, `approvalPolicy: "never"` ERSETZEN durch `RUNTIME_MODE_TO_CODEX[runtimeModeForChat(context.chat)]`.
- `lib/providers/runner.ts` `runClaude` (~Zeile 1511): hardcoded `permissionMode: "acceptEdits"` ERSETZEN durch Mapping. Bei `full-access` zusätzlich `allowDangerouslySkipPermissions: true` setzen (SDK-Pflicht bei bypassPermissions).
- GLM/AI-SDK-Pfad (`runAiSdk`): runtimeMode an Gateway weiterreichen (siehe Teil B3).

## Teil B — Interaktiver Approval-Flow

### B1. Approval-Store `lib/db-approvals.ts` (Spiegel von lib/db-questions.ts!)
ERST `lib/db-questions.ts` komplett lesen — die Struktur (Tabelle, resolve, heartbeat, limits) 1:1 spiegeln:
- Tabelle `pending_approvals`: `id TEXT PK, job_id TEXT, chat_id TEXT, owner_id TEXT, status TEXT ('waiting_for_user'|'resolved'), title TEXT, command TEXT, files_json TEXT, created_at TEXT, heartbeat_at TEXT, resolved_at TEXT, decision TEXT, session_scope TEXT`
- `createApproval({jobId, chatId, ownerId, title, command?, files?}) → {approvalId}`
- `resolveApproval(approvalId, decision: "allow"|"allow-session"|"deny", userId, version?) → {jobId, chatId, decision} | null`
- `heartbeatApproval(approvalId)` — wird vom wartenden Runner-Code getickt
- `getPendingApprovalForChat(chatId, userId)`
- Decision-Normalisierung: "allow-session" → für die Session merken (siehe B3 Gateway / B2 canUseTool: session-allowliste im Chat-Objekt `approvedPatterns?: string[]`, simple prefix-Matches auf command).

### B2. Claude-Pfad: canUseTool-Verdrahtung (`runner.ts` runClaude)
Bei `canUseToolRequired === true`:
```ts
canUseTool: async (toolName, input, { signal, suggestions, title }) => {
  // session-allowliste prüfen (chat.approvedPatterns prefix-match auf JSON.stringify(input) oder command) → allow
  // sonst: createApproval(...) + Chat-pendingApproval setzen (updateChat)
  // dann pollen (500ms Intervall) auf resolveApproval ODER signal.aborted ODER heartbeat ticken (alle 2s)
  // decision "deny" → { behavior: "deny", message: "User denied" }
  // "allow"/"allow-session" → { behavior: "allow", updatedPermissions: suggestions }
  //    (bei allow-session zusätzlich pattern in chat.approvedPatterns speichern)
  // Timeout: 10 Minuten ohne Antwort → deny mit Hinweis
}
```
Nach Resolution: `updateChat(chatId, { pendingApproval: undefined })`.

### B3. GLM/AI-SDK-Pfad: Gateway-Gating (`lib/mcp-core/gateway-core.mjs`)
- Der Gateway läuft als stdio-Child pro Job (lib/mcp.ts `getMcpServers` baut env). Dort env `AI_CHAT_RUNTIME_MODE` mit dem runtimeMode des Jobs setzen (in `lib/mcp.ts` — der Context muss von worker-runner/runner den chat-runtimeMode bekommen; dort wo jetzt MCP_MODE_POLICY gesetzt wird, gleiche Stelle).
- In `gateway-core.mjs`: in der zentralen Tool-Dispatch-Stelle (dort wo `assertModePolicy`/Kategorie-Check läuft) VOR Ausführung: wenn `AI_CHAT_RUNTIME_MODE === "approval-required"` UND Tool-Kategorie ist `terminal` oder `write`:
  1. Session-allowliste prüfen (persistiert via `/api/internal/mcp-approval` GET/POST — einfacher: die Allowliste im Chat-Objekt halten, der Gateway fragt per HTTP den Status ab, exakt wie `ask_user` es tut: fetch auf INTERNAL_URL-artigen Endpoint, siehe Zeile ~2809 `ask_user`-Implementierung als Muster)
  2. Sonst: POST auf neue interne Route `/api/internal/mcp-approval` `{jobId, chatId, title, command/toolName, args}` → Route legt pending_approval an + updateChat(pendingApproval) → Gateway pollt GET `/api/internal/mcp-approval?id=<id>` bis `status: resolved` (Long-Poll oder 1s-Poll, Timeout 10min) → decision deny → Tool-Error an Modell zurück ("User denied this action"), allow → ausführen.
- WICHTIG: `AI_CHAT_INTERNAL_ORIGIN`-Pattern von ask_user übernehmen (gateway-core.mjs Zeile ~58 INTERNAL_URL + mcp.ts env). Der Gateway-Kindprozess erreicht die Next-API über loopback HTTP — ask_user beweist, dass das funktioniert.
- Kategorie-Bestimmung existiert schon (`modeToolCategory` für mode policy) — wiederverwenden.

### B4. API-Routen
- `app/api/chat/approval/route.ts` (Spiegel von `app/api/chat/answer/route.ts`): POST `{approvalId, decision}` → auth → `resolveApproval` → bei zugeordnetem Job mit stale heartbeat KEIN re-queue nötig (der Runner pollt aktiv) → pendingApproval aus Chat-Daten räumen → 200 `{ok:true}`. Invalid/404-Handling wie answer-Route.
- `app/api/internal/mcp-approval/route.ts`:
  - POST (vom Gateway, internal origin): approval anlegen + chat.pendingApproval setzen → `{approvalId}`
  - GET `?id=`: Status-Abfrage für Gateway-Poll → `{status, decision?}`
  - Absicherung: nur loopback/interne Aufrufe (gleicher Schutz wie bestehende `/api/internal/mcp-question`-Route — deren Muster kopieren).

### B5. Chat-Typ + UI
- `lib/store.ts`: `pendingApproval?: { id: string; title: string; command?: string; files?: Array<{path: string; status: string}>; createdAt: string }` und `approvedPatterns?: string[]` am Chat.
- `components/approval-panel.tsx` NEU: kompakte Karte (1px Border, monochrom, kein Gradient): Titel (z.B. "Command approval required"), Command in `<code>`-Block (mono, scrollbar bei lang), 3 Buttons: `Allow`, `Allow session`, `Deny` (Deny = secondary/outline). Bei allow-session Tooltip "Für diesen Chat nicht wieder nachfragen (Präfix-Match)".
- `components/app-shell.tsx`: RENDER dort, wo pendingQuestion gerendert wird (suche `pendingQuestion` in app-shell.tsx — gleiche Stelle, direkt daneben/darüber). Chat-Poll (10s) existiert → Panel erscheint automatisch; nach Resolution → Chat-Reload-Mechanismus von pendingQuestion kopieren (dort wird bei Antwort der Chat aktualisiert).
- Button-Handler: `fetch("/api/chat/approval", {method:"POST", body: JSON.stringify({approvalId, decision})})` → danach Chat-Refresh (bestehende loadChats/einzelnen Chat laden).

### B6. Composer RuntimeMode-Switcher
- In den Composer-Controls neben dem Mode-Switcher (app-shell.tsx ~Zeile 3410 `selectMode` — dort ist die Mode-Persistenz via localStorage + chat.sessionState.modeId; exakt dieses Muster für `runtimeMode` spiegeln, Storage-Key `metis.runtimeMode`).
- Darstellung: kleines Dropdown/Segment mit 4 Optionen + Icons (shield-alert / file-pen / bot / unlock — lucide, monochrom). Labels: `Approval required`, `Auto-accept edits`, `Auto`, `Full access`. Default: Full access.
- Beim Wechsel: chat speichern via bestehende Chat-Update-API (dieselbe, die modeId speichert — persistence in sessionState UND chat.runtimeMode via PATCH).

### B7. Telegram-Formatting
- `lib/formatting.ts` `stripInternalBlocks()`: falls der Agent bei wartender Approval Text mit ```plan-artigen Blöcken schickt — nichts zu tun. ABER: pendingApproval soll NICHT nach Telegram gepusht werden (kein Breaking) — nur Web-UI. Keine Telegram-Änderung nötig, dokumentieren.

## Tests (NEU: `tests/runtime-mode.test.ts` + Erweiterungen)
1. `normalizeRuntimeMode`: valide/invalid/default.
2. Mapping-Tabellen: jede RuntimeMode hat vollständige Codex- und Claude-Einträge.
3. `db-approvals` Roundtrip: createApproval → resolveApproval("allow") → Status resolved; doppelt-auflösen → null.
4. Gateway-Gating (Integration, stdio-Spawn wie `tests/work-ledger.test.ts`): mit `AI_CHAT_RUNTIME_MODE=approval-required` muss `execute_command` NICHT sofort laufen sondern auf Approval warten → nach POST+resolve via interne Route (oder direktem DB-Eintrag) läuft das Tool; `AI_CHAT_RUNTIME_MODE=full-access` = unverändertes Verhalten. Falls flaky: mindestens Unit-Test der Gate-Entscheidungsfunktion (kategoriert + mode) als pure Funktion extrahieren und testen.
5. Claude-canUseTool-Logik: die Poll/Allowlisten-Entscheidung als pure Funktion extrahieren (`shouldAutoApprove(patterns, toolName, input)`) und testen.

## Verifikation (vom Agenten auszuführen)
1. `npx tsc --noEmit` → 0 errors.
2. `pnpm test` → alles grün.
3. `grep -rn "approvalPolicy: \"never\"\|sandboxMode: \"workspace-write\"" lib/providers/runner.ts` → darf nur noch im Mapping-Kontext vorkommen, nicht hardcoded im runCodex.
4. Keine Secrets/personal-Strings im Diff (`grep -rn "samuelm\|/home/samuel" --include="*.ts" --include="*.tsx"` auf neue/geänderte Dateien).

## NICHT in dieser Phase
- Kein Plan-Mode-Protokoll (Phase 2), kein Checkpointing (Phase 4), kein Timeline-Rewrite (Phase 3).
- Codex interaktive Approvals via app-server-Protokoll (t3's effect-codex-app-server) — Phase 2+. approval-required ist bei Codex = read-only+untrusted (Mutation schlägt fehl, Modell erhält Fehlermeldung).
- Keine Änderungen an modeId/AgentMode-System (bleibt orthogonal).
