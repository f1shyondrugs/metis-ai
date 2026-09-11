# Metis AI – priorisierter Modernisierungsplan

> **Status:** Snapshot **21 Aug 2026**. Reihenfolge weiter nützlich; Live-P0/P1 stehen in [PRODUCTION-AUDIT.md](./PRODUCTION-AUDIT.md).

**Stand:** 2026-08-21  
**Basis:** [METIS_ARCHITECTURE_AUDIT.md](./METIS_ARCHITECTURE_AUDIT.md)  
**Prinzip:** Kein Big Bang. Jede Stufe ist rückwärtskompatibel, messbar, durch Feature Flags abschaltbar und besitzt einen Rollback-Pfad.

## 1. Verbindliche Arbeitsregeln

Vor jeder Implementierungswelle:

1. Arbeitsbaum und bestehende Änderungen inventarisieren.
2. Datenbanksicherung mit Restore-Probe erstellen.
3. Eigene Branch pro Slice anlegen; keine Vermischung mit den bereits vorhandenen fünf Änderungen.
4. Migrationen expand/contract ausführen, niemals Spalten oder Daten im ersten Schritt löschen.
5. Tests zuerst bzw. zusammen mit der Änderung liefern.
6. `lint`, `typecheck`, Tests, isolierten Clean Build und relevante Fault-Injection bestehen.
7. Canary/Feature Flag, Metriken und dokumentierten Rollback definieren.
8. Keine Produktionsdienste für Entwicklungs-/Lasttests verwenden.

Prioritätsdefinition:

- **P0:** verhindert sicheren autonomen oder Multi-User-Betrieb;
- **P1:** verhindert verlässliche Orchestrierung, Recovery oder Betrieb;
- **P2:** Skalierung, Wartbarkeit und Produktqualität nach P0/P1.

## 2. Ziel-SLOs

| Bereich | Ziel |
|---|---|
| Enqueue p95 bei 20 parallelen Runs | < 50 ms |
| Claim-Duplikate | 0 |
| doppelte externe Side Effects nach Crash/Retry | 0 für idempotente/receipt-fähige Tools |
| Cancel bis terminal p95 | < 5 s; harter Kill < 15 s |
| verlorene durable Events | 0 |
| SSE-Reconnect | vollständiges Replay ab Cursor |
| Cross-Tenant-Zugriffe | 0 in Negativsuite |
| Tool außerhalb Manifest | 0; bereits in Discovery unsichtbar |
| Build/Releasetore | lint + typecheck + tests + clean build grün |
| DB-Lock-Fehler | 0 in normaler Last; gemessene Lock-Wait-Metrik |
| Provider Contract | jeder aktive Adapter besteht Stream/Tool/Error/Cancel/Timeout |

## 3. P0 – Security Boundary zuerst

### P0.1 Remote-Approval serverseitig machen

**Problem:** `remote_client_terminal` bietet `approved` als Modellargument an und reicht es bis `requestRemoteClient` durch.

**Änderungen:**

- `approved` vollständig aus MCP-Toolschemas und Modellargumenten entfernen.
- Tabellen `approval_requests` und `approval_decisions` ergänzen.
- Request bindet `owner_id`, `run_id`, `tool_call_id`, `client_id`, Aktion, kanonischen Args-Hash, Ablaufzeit und Nonce.
- UI entscheidet über authentifizierte API.
- Gateway akzeptiert nur eine serverseitig erzeugte Approval-ID und konsumiert sie atomar genau einmal.
- Änderung der Args invalidiert die Approval.
- Late/Replayed Approvals werden abgelehnt und auditiert.

**Tests:** Modell setzt boolesches Approval; falscher User; geänderte Args; abgelaufen; doppelt konsumiert; Parent-/Child-Verwechslung.

**Done:** Kein modellkontrollierter Wert kann eine Approval ersetzen.

### P0.2 Redirect-sicheren SSRF-Schutz implementieren

**Scope:** `app/api/link-preview/route.ts`, gemeinsamer URL-Security-Helper.

**Status (goal-loop iteration 5):** Implemented for link previews and the
browser request guard. Redirects are followed manually with validation at
every hop, DNS results are checked completely, and response bodies are read
with a hard byte limit. Regression coverage is in `tests/url-security.test.ts`.

**Änderungen:**

- `fetch(..., { redirect: "manual" })`.
- Maximal 3–5 Redirects; jeden Hop neu validieren.
- DNS A/AAAA vollständig prüfen; Loopback, Private, Link-local, CGNAT, Multicast, Metadata-Endpunkte und IPv4-mapped IPv6 sperren.
- Verbindungen nach Möglichkeit an validierte IP binden oder sicheren Egress Proxy verwenden.
- Content-Type prüfen und Body während des Lesens begrenzen, nicht erst nach `response.text()`.
- Link-Preview und Browser verwenden denselben getesteten Policy-Kern.

**Tests:** 30x auf `127.0.0.1`, `169.254.169.254`, IPv6, encoded IP, Rebinding, Redirectloop, großer Body.

### P0.3 Legacy-Authentifizierung fail-closed machen

**Scope:** `lib/auth.ts`, Deployment-Konfiguration.

**Änderungen:**

- `x-chat-password` als allgemeine Benutzeranmeldung deaktivieren.
- Falls Migrationskompatibilität zwingend ist: nur über separaten internen Listener/mTLS und fest gebundenen Migrationsaccount; `x-chat-username` ignorieren.
- Proxy-Trust explizit konfigurieren; Forwarded Header nur vom bekannten Proxy akzeptieren.
- Session-Revoke/Rotation und Cleanup ergänzen.
- Gemeinsames Rate Limit in Redis/DB mit IP- und Account-Schlüssel.

**Tests:** Globalpasswort + anderer Username, gespoofte Forwarded-IP, abgelaufene/revokte Session, Cross-User.

### P0.4 Tenant Ownership schließen

**Scope:** Chats, Jobs, Events, Attachments, Browser, Subagents, Automationen, Remote Clients.

**Änderungen:**

- neue Owner-Felder `NOT NULL`;
- Legacy-`NULL`-Rows in expliziter, auditierter Migration einem bekannten Owner zuordnen oder quarantänisieren;
- `OR user_id IS NULL` aus authentifizierten Queries entfernen;
- alle Reads/Writes mit Owner-Join bzw. Composite Key;
- DB-Constraints/FKs;
- negative Route- und Repository-Tests für zwei Benutzer.

**Rollout:** erst Shadow-Queries/Telemetry, dann Migration, dann Feature Flag auf strict, zuletzt alten Fallback entfernen.

### P0.5 CapabilityManifest einführen

**Neue Komponente:** `lib/capabilities/*`.

**Status (goal-loop iteration 6):** The internal gateway now uses an explicit
tool-category catalog for discovery and execution. Name-based regex inference
was removed; unknown tools are denied under a manifest unless an exact tool
override grants them. Manifest categories and boolean overrides are validated
before discovery or execution. Focused tests verify that all built-in tools are
classified, memory and plan tools remain isolated, and malformed categories
fail closed.

**Status (goal-loop iteration 7):** Capability manifests are now persisted in
SQLite by `(owner_id, run_id, attempt_id)` with an immutable hash check. The
same manifest is reused when an MCP context is reconstructed, and the gateway
validates optional server/tool-scoped child-MCP grants during server listing,
tool discovery, schema listing, and invocation. The child-grant field is
currently opt-in so existing manifests preserve configured MCP behavior; the
remaining rollout step is to compile grants from the configured registry and
mode before making the field mandatory and fail-closed.

**Status (goal-loop iteration 8):** The rollout is now fail-closed at the
manifest boundary: every newly compiled manifest contains an explicit
`childMcpGrants` map, the gateway rejects legacy manifests without it, and
child-MCP discovery/invocation deny servers and tools absent from that map.
Child-MCP connection and in-flight connection caches are also scoped by
`owner_id` so owner-specific registry entries cannot reuse another owner's
live connection. Existing call sites default to an empty map until configured
server/tool grants are compiled from installation policy.

**Manifestinput:** User/Rolle, Mode, Workspace, Provider/Model, Automation, Incognito, Remote Client, Run/Attempt.

**Änderungen:**

- Toolkatalog vor Providerstart filtern.
- Keine verbotenen Toolnamen/-schemas in Model-Context.
- Gateway prüft exakt dasselbe Manifest anhand von `policy_version` und Hash.
- Child-MCP Discovery liefert nur server/tool-scoped Grants.
- Toolkategorie ist Metadatum, keine Namensregex.
- `call_mcp_tool` darf nur explizit freigegebene Server/Tools aufrufen.
- Manifest pro Attempt persistieren.

**Initiale Rollen:**

| Rolle | Grants |
|---|---|
| Coding Reader | repo/fs read, diff |
| Coding Executor | Reader + patch + Tests; Shell separat |
| Research | Web/Papers/Notes; keine Shell |
| Browser Reader | Navigate/Snapshot |
| Browser Actor | Reader + mutierende Browseraktionen, Approval nach Policy |
| Reviewer | Diff/Tests/Findings; kein Remote/Browser-Write |
| Automation | deklarierte non-interaktive Grants |
| Remote Executor | exakt ein Client und Actionscope |

### P0.6 Disposable Sandbox für Executor

**Änderungen:**

- Rootless Container/MicroVM pro Run oder pro isolierter Run-Gruppe.
- Nur Workspace/Artifacts explizit mounten; Secrets und Browserprofile nicht mounten.
- Read-only Rootfs, tmpfs, UID-Mapping, Prozess-/CPU-/RAM-/Disk-/Zeitlimits.
- Standardmäßig kein Netzwerk; per Capability Egress-Allowlist.
- Providerzugang über Secret Broker/Proxy mit kurzlebigem Token.
- Shell und Child-MCP in derselben Policy-Domain.
- Sandbox-ID im Attempt und Trace.

**Migration:** zuerst Coding Runs hinter Flag, dann Research/Automation; Hostpfad als kontrollierter Fallback bis Parität erreicht ist.

## 4. P1 – kanonische Orchestrierung und Zuverlässigkeit

### P1.1 Einen gemeinsamen Run-Service schaffen

`POST /api/chat` und `POST /api/runs` rufen denselben `RunService.start()` auf. Dieser besitzt Auth, Idempotenz, Messageinsert, Runinsert und Outboxevent.

**DB-Invariante:** partieller Unique Index auf aktiven Run pro Chat.

### P1.2 Run-State-Machine

**Tabellen/Typen:**

- `runs(id, owner_id, chat_id, status, version, current_attempt_id, idempotency_key, ...)`
- `run_attempts(id, run_id, provider, model, context_snapshot_id, sandbox_id, ...)`
- `run_leases(run_id, worker_id, token, expires_at)`
- `run_dependencies(parent_run_id, child_run_id, state)`

Transitions erfolgen ausschließlich über compare-and-set:
`UPDATE runs SET status=?, version=version+1 WHERE id=? AND version=? AND status IN (...)`.

Chat-`runStatus` wird Projection und darf nicht mehr Runtime-Source-of-Truth sein.

**Status (goal-loop iteration 9):** The existing durable job path now has an
explicit transition table and a monotonic per-job revision embedded in the
stored job record. Claims, normal updates, heartbeats, requeues, and model
handoffs use revision-aware writes; callers can supply an expected revision
and stale writers are rejected. This is an incremental guard for the current
`jobs` aggregate, not yet the separate normalized `runs`/`run_attempts` schema
described above.

**Status (goal-loop iteration 10):** An additive `job_leases` table now issues
per-claim worker IDs, fencing tokens, and expirations. The token is passed only
to the isolated worker process; worker updates and heartbeats are rejected when
the lease is stale, terminal/switching transitions release the lease, and the
worker requeues expired running leases from the durable checkpoint. This
reduces late-writer risk in the current aggregate while normalized
`runs`/`run_attempts` records and full lease ownership remain future work.

### P1.3 Durable Events + Live Fanout trennen

- Append-only `run_events(run_id, seq, type, payload_ref, created_at)`.
- Unique `(run_id, seq)`.
- PostgreSQL-Outbox oder zunächst SQLite-Outbox.
- Große Payloads in Object Storage/Artifacts.
- Live-Events über Redis Streams/PubSub/WebSocket; Verlust dort ist akzeptabel.
- SSE bekommt Cursor und liest bei Reconnect durable Events nach.
- Keine globale „neueste 10.000“-Löschung.

**Status (goal-loop iteration 11):** `appendRunEvent` now applies the same
active-worker-lease check before inserting durable events. Late events from a
stale or cancelled isolated child are dropped with a structured
`dropped: "stale_lease"` result, while control-plane recovery events without a
worker token remain allowed. This closes the durable event path incrementally;
chat projections, tool receipts, and sequence-level event invariants remain.

**Status (goal-loop iteration 12):** Direct worker-side chat projections now
validate the child job lease before `createChat`, `updateChat`, `appendMessage`,
and `upsertMessage`. A stale child cannot create or mutate chat transcript
state through these local persistence paths. HTTP control-plane routes remain
separate and require their own run-aware fencing before they can be considered
fully covered.

**Status (goal-loop iteration 13):** The internal chat and workspace mutation
routes now require a valid worker ID/token pair bound to the supplied job ID.
The MCP gateway propagates those headers for the targeted chat/workspace calls,
and invalid or expired leases return HTTP 409 before persistence. Internal
file, notes, browser, question, subagent, automation, and memory routes remain
outside this slice.

### P1.4 Tool-Receipts und Exactly-once-Näherung

Für jede mutierende Toolaktion:

1. Call mit stabiler `idempotency_key`;
2. `tool_call_started` durable;
3. Executor/Tool prüft bereits vorhandenes Receipt;
4. Side Effect;
5. Receipt mit Resultathash;
6. `tool_call_finished`.

Nicht-idempotente Drittanbieter ohne Idempotency Support werden bei unklarem Crashzustand `requires_review`, nicht blind retried.

### P1.5 End-to-End-Cancellation

- `cancellation_requested_at` separat vom Terminalstatus;
- AbortSignal API → Orchestrator → Provider → MCP → Tool → Browser/Remote;
- Kindprozessgruppe nach Grace Deadline terminieren;
- Lease/Fencing verhindert Late Writes;
- terminale Runs akzeptieren keine Text-/Tool-Events mehr;
- Cancel von Parent propagiert als Dependency-Operation.

### P1.6 Scheduler/Subagent-Ressourcenmodell

- Leases mit Worker-ID, Expiry und Fencing Token;
- periodischer Reaper, nicht nur Startup-Recovery;
- separate Pools/Quotas für interactive, background, browser, subagent;
- Parent-Wait verbraucht keinen Executor-Slot;
- keine 30-Minuten-HTTP-Anfrage; Child Completion als durable Event/Dependency;
- Unique Key für Reviewer;
- Taskhash enthält normalisierten Titel + Prompt + Manifest;
- Workspace-Locks oder getrennte Worktrees und expliziter Merge/Review.

### P1.7 ProviderAdapter normalisieren

```ts
interface ProviderAdapter {
  probeCapabilities(): Promise<CapabilityEvidence>;
  start(input: RunAttemptInput): AsyncIterable<CanonicalProviderEvent>;
  cancel(attemptId: string, deadline: Date): Promise<void>;
  resume(checkpoint: ProviderCheckpoint): AsyncIterable<CanonicalProviderEvent>;
  close(): Promise<void>;
}
```

Kanonische Events: `started`, `text_delta`, `reasoning_delta`, `tool_call_started`, `tool_call_finished`, `usage`, `rate_limit`, `error`, `finished`.

- Codex/Antigravity: Dispatcher entweder wirklich auf SDK/CLI umstellen oder Registry ehrlich auf OAuth-AI-SDK ändern.
- Tote `runCodex`-/`runAntigravity`-Pfade entfernen, sobald Migration belegt ist.
- „verified“ nur nach echter Probe mit Evidenz/Timestamp.
- Retry nur für klassifizierte transiente Fehler, mit Jitter und Idempotenz.
- Circuit Breaker und per Provider Quota.

### P1.8 SQLite stabilisieren, bevor migriert wird

- Heartbeat/status nur typed Columns;
- inkrementelle Message-/Part-/Eventwrites;
- kein Voll-Chat-Checkpoint pro Delta/Tool;
- ein asynchroner, gebatchter Eventwriter;
- keine `Atomics.wait`-Backoffs in API-Eventloops;
- Lock Wait, Transaction Duration, WAL Size, Busy Count messen;
- Queuezählungen/JSON-Extraktion aus Enqueue entfernen oder indexieren;
- Active-Run-Constraint in DB.

Go/No-Go nach Lasttest. Bleiben p95/Recovery außerhalb SLO, beginnt P2-Postgresmigration.

### P1.9 Frontend entkoppeln

Aus `app-shell.tsx` extrahieren:

- Chat Repository/Query Cache;
- Run Store/Reducer;
- Composer State Machine;
- Browser Store;
- Navigation;
- Subagent/Automation Projections.

SSE ist Primärkanal, Snapshotfetch Recovery. Polling nur als Health-Fallback mit Backoff/Jitter. Optimistische Updates erhalten stabile IDs und werden durch Eventsequenzen reconciled.

### P1.10 Release-/Build-Hygiene

- den einen Lintfehler und 17 Warnungen beheben/entscheiden;
- alle 41 Testdateien bewusst in Scripts klassifizieren: unit, integration, live;
- `.next*`, `node_modules`, `data`, Provider-Sessions und Browserprofile aus Buildkontext;
- `@cursor/sdk` und sonstige Floating-Versionen pinnen;
- ignoriertes pnpm-Feld in aktuelle Config migrieren;
- Clean Checkout CI: install frozen → lint → typecheck → tests → build;
- SBOM, Dependency Scan und Migrations-Dry-Run.

## 5. P2 – Datenplattform, Workflows und Qualität

### P2.1 Conversation Normalization

Tabellen: `messages`, `message_parts`, `tool_calls`, `tool_results`, `attachments`, `chat_projections`. Dual-write hinter Flag, Backfill, Read-Compare, Cutover, später JSON-Felder auslaufen lassen.

### P2.2 PostgreSQL + Queue + Object Storage

**Reihenfolge:**

1. Postgres Schema und Outbox;
2. dual-write Runs/Events;
3. Read-Compare;
4. Queue/Leases;
5. Messages;
6. Artifacts/Object Storage;
7. SQLite read-only Fallback/Export;
8. erst nach Restore-/Rollback-Probe Altpfad entfernen.

Redis ist für Leases, Rate Limits und Live-Fanout; canonical state bleibt Postgres.

### P2.3 Context Compiler

Budgetierte Segmente: Instructions, Recent Messages, Summary, Toolschemas, Toolresults, Memories/Notes, Attachments und Provideroverhead. Persistiert werden Inputs, Tokenestimate, Kürzungen, Summary-Version und Hash. Tools werden lazy nach Taskklasse/Manifest geladen.

### P2.4 Durable Workflow Graph

Planner, Executor, Approval, Wait, Reviewer und Synthesis als explizite Nodes. Deterministische Schritte bleiben Code; nur unsichere Entscheidungen gehen ans Modell. Jeder Node ist checkpointbar und replaybar. Automations-UI-Graph wird erst dann ausführbar, wenn Typen, Versionierung und Migration definiert sind.

### P2.5 Observability/Evaluation

OpenTelemetry-Spans über `run_id`, `attempt_id`, `tool_call_id`, Provider Request ID, Sandbox und DB-Transaction.

Dashboards:

- Queuewait und Laufzeit;
- SQLite/Postgres Lockwait;
- Providerlatency/429/Fehler;
- Toollatenz/Timeout/Approval;
- Contextgröße/Compaction;
- Kosten/Tokens;
- Cancel-/Recovery-Latenz;
- Duplicate/Rejected Late Events.

Trajectory-Evals prüfen nicht nur „Tests grün“, sondern Exploration, Side Effects, Verifikation, Policy und Wiederholungen.

## 6. Testprogramm als eigener Deliverable

### Testprojekte

| Suite | Inhalt |
|---|---|
| `architecture` | Dependency-Regeln, keine direkten Chatstatuswrites, Manifestpflicht |
| `lifecycle` | alle Zustände, Resume, Cancel, Crashboundary |
| `tools` | Schema, Capability, Approval, Receipt, Timeout |
| `providers` | Contract Fixtures je Adapter |
| `security` | SSRF, Tenant, Prompt Injection, Secrets, Sandbox |
| `stress` | 20 Runs, gleiche Chats, Multiworker, Eventflood |
| `browser-live` | isolierte Browserinstanz und Testaccounts |
| `migration` | expand/contract, Backfill, Rollback, Restore |

### Pflichtsimulationen

- 20 parallele Agent Runs mit Fakeprovider;
- 20 Sends auf einen Chat;
- Toolfehler vor/nach Side Effect;
- Provider-Timeout und 429;
- Worker SIGKILL an jeder Boundary;
- Netzwerkverlust im Stream und MCP;
- forcierter Datenbank-Lock;
- Parent mit 8 Kindern bei knappen Slots;
- Browser-Action-Timeout/Frame-Backpressure;
- SSE Disconnect/Reconnect.

Jede Simulation prüft DB-Invarianten, Eventsequenz, Side-Effect-Count, Terminalstatus und offene Prozesse/Handles.

## 7. Lieferreihenfolge

| Welle | Umfang | Abhängigkeit | Releasekriterium |
|---|---|---|---|
| 0 | Baseline, Branch, Backup/Restore, Metriken, Testklassifikation | keine | reproduzierbarer Clean Build |
| 1 | P0.1–P0.3: Approval, SSRF, Legacy Auth | Welle 0 | Securitytests grün |
| 2 | P0.4–P0.5: Ownership, CapabilityManifest | Welle 1 | Cross-Tenant 0; versteckte Tools 0 |
| 3 | P0.6: Sandbox | Welle 2 | Escape/Egress-Suite grün |
| 4 | RunService + State Machine + Leases | Welle 2 | Lifecycle/Fault-Suite grün |
| 5 | Durable Events + Receipts + Cancel | Welle 4 | Replay/Crash SLOs |
| 6 | Provideradapter + Subagent Scheduler | Welle 5 | Contract-/Fanout-Suite |
| 7 | Frontend/Release Hygiene | parallel ab Welle 4 | UI E2E + Clean CI |
| 8 | Normalisierung/Postgres/Object Storage | Messwerte nach Welle 5 | Dual-read parity + Rollback |
| 9 | Workflow Graph/Context/Evals | stabile Datenbasis | Benchmark + Kosten/SLO |

## 8. Nicht tun

- keinen sofortigen Komplettrewrite;
- SQLite nicht ohne Messwerte einfach durch fünf neue Systeme ersetzen;
- keine Approval als Promptregel oder Boolean;
- keinen vollständigen Toolkatalog laden und nur auf Call-Zeit hoffen;
- Providerfähigkeiten nicht aus Registrydeklarationen als „verified“ ausgeben;
- keine Crash-Retries für unklare Side Effects;
- keine Produktionsdaten für Stress-/Browser-/Faulttests;
- alte JSON-Felder erst nach Dual-Read-Parität und Rollbackfenster entfernen.

## 9. Definition of Done der Gesamtmodernisierung

Metis gilt als robuste Agent-Plattform, wenn:

1. jeder Run genau einen kanonischen, replaybaren Zustand besitzt;
2. jede riskante Aktion an ein kleines CapabilityManifest und gegebenenfalls ein echtes Approval-Receipt gebunden ist;
3. Executor, Browser und Secrets durch starke Isolation getrennt sind;
4. Crash, Timeout, Cancel und Netzwerkverlust keine doppelten Side Effects oder unklaren aktiven Runs erzeugen;
5. Provider dieselbe Event-/Error-/Cancel-Semantik erfüllen oder ihre Abweichung explizit deklarieren;
6. 20 parallele Runs die SLOs erfüllen;
7. alle Cross-Tenant- und SSRF-Negativtests grün sind;
8. ein Clean Checkout ohne Runtime-Artefakte reproduzierbar baut;
9. jede Migration restore- und rollback-getestet ist;
10. UI und Operatoren einen vollständigen, forensisch brauchbaren Run-Trace sehen.
