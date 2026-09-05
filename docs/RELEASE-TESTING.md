# Release- und Upgrade-Tests

## Lokale, netzwerkfreie Vertragsprüfung

Diese Prüfung verändert keine Installation und veröffentlicht nichts:

```bash
pnpm test:release
pnpm exec tsx --test tests/release-manifest.test.ts tests/github-releases.test.ts
pnpm exec tsc --noEmit --pretty false
```

`pnpm test:release` prüft:

- Stable-Manifest für einen Testtag mit Commit
- Docker-Installer-Dry-Run ohne erzeugte `.env` oder Compose-Datei
- Ablehnung von Branchnamen statt SemVer-Tags
- SHA256-Prüfsummenformat

## Erstes echtes Release

1. `package.json.version` und Tag müssen übereinstimmen.
2. CI muss auf dem Tag erfolgreich sein.
3. Der Release-Workflow veröffentlicht GitHub-Assets und das GHCR-Image.
4. Den Installer in einem separaten Testverzeichnis ausführen:

```bash
bash metis-docker-install.sh \
  --version v1.0.0 \
  --install-dir "$HOME/metis-ai-e2e" \
  --data-dir "$HOME/metis-ai-e2e-data" \
  --workspace "$HOME/metis-ai-e2e-workspace"
```

Danach prüfen:

- `/api/system/version` meldet die erwartete Version.
- Ein Sentinel-Dokument in Daten und Workspace bleibt nach dem Upgrade erhalten.
- `docker compose ps` zeigt App, Worker und MCP als healthy/running.
- Ein Upgrade auf den nächsten Tag ändert nur den Image-Tag.
- Ein absichtlich fehlerhafter Healthcheck wird erkannt, ohne Datenverzeichnisse zu löschen.

Produktions-Metis wird für diese Tests nicht gestoppt oder neugestartet. Rollback-Tests laufen ausschließlich im separaten E2E-Installationsverzeichnis.
