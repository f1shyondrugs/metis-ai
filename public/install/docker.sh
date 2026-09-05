#!/usr/bin/env bash
# Reproducible Docker-first installer for Metis AI releases.
# It never clones the repository and never removes data or workspace files.
set -Eeuo pipefail

IMAGE_REPOSITORY="${METIS_IMAGE_REPOSITORY:-ghcr.io/f1shyondrugs/metis-ai}"
VERSION="${METIS_RELEASE_VERSION:-latest}"
INSTALL_DIR="${METIS_INSTALL_DIR:-$HOME/metis-ai}"
DATA_DIR="${METIS_DATA_DIR:-}"
WORKSPACE_DIR="${METIS_WORKSPACE:-}"
PORT="${PORT:-3100}"
BIND="${AI_CHAT_BIND:-127.0.0.1}"
MCP_PORT="${MCP_PORT:-8787}"
NON_INTERACTIVE=0
DRY_RUN=0

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: docker.sh [options]

Installs or upgrades Metis AI from a versioned image on GHCR.

Options:
  --version VERSION       Release tag such as v1.0.0, or latest (default: latest)
  --install-dir DIR       Compose/config directory (default: ~/metis-ai)
  --data-dir DIR          Persistent application data (default: INSTALL_DIR/data)
  --workspace DIR         Persistent agent workspace (default: INSTALL_DIR/workspace)
  --port PORT              Web port (default: 3100)
  --bind HOST              Bind address (default: 127.0.0.1)
  --mcp-port PORT          MCP gateway port (default: 8787)
  --image-repository REPO  GHCR repository (default: ghcr.io/f1shyondrugs/metis-ai)
  --non-interactive        Do not prompt
  --dry-run                Print the planned configuration without changing files
  -h, --help               Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) [[ $# -ge 2 ]] || fail "--version requires a value"; VERSION="$2"; shift 2 ;;
    --install-dir) [[ $# -ge 2 ]] || fail "--install-dir requires a value"; INSTALL_DIR="$2"; shift 2 ;;
    --data-dir) [[ $# -ge 2 ]] || fail "--data-dir requires a value"; DATA_DIR="$2"; shift 2 ;;
    --workspace) [[ $# -ge 2 ]] || fail "--workspace requires a value"; WORKSPACE_DIR="$2"; shift 2 ;;
    --port) [[ $# -ge 2 ]] || fail "--port requires a value"; PORT="$2"; shift 2 ;;
    --bind) [[ $# -ge 2 ]] || fail "--bind requires a value"; BIND="$2"; shift 2 ;;
    --mcp-port) [[ $# -ge 2 ]] || fail "--mcp-port requires a value"; MCP_PORT="$2"; shift 2 ;;
    --image-repository) [[ $# -ge 2 ]] || fail "--image-repository requires a value"; IMAGE_REPOSITORY="$2"; shift 2 ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"
DATA_DIR="${DATA_DIR:-$INSTALL_DIR/data}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$INSTALL_DIR/workspace}"

[[ "$VERSION" == "latest" || "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || \
  fail "Version must be latest or a v-prefixed SemVer tag, for example v1.0.0."
[[ "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1 && "$PORT" -le 65535 ]] || fail "Invalid web port: $PORT"
[[ "$MCP_PORT" =~ ^[0-9]+$ && "$MCP_PORT" -ge 1 && "$MCP_PORT" -le 65535 ]] || fail "Invalid MCP port: $MCP_PORT"
[[ "$IMAGE_REPOSITORY" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "Invalid image repository."

if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  fail "Docker Compose v2 (docker compose) or docker-compose is required."
fi
docker info >/dev/null 2>&1 || fail "Docker is not running or the current user cannot access it."

IMAGE="${IMAGE_REPOSITORY}:${VERSION}"
ENV_FILE="$INSTALL_DIR/.env"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
MANIFEST_FILE="$INSTALL_DIR/.metis-release.json"

if (( DRY_RUN )); then
  cat <<EOF
Dry run; no files, containers, or data will be changed.
  image:     $IMAGE
  install:   $INSTALL_DIR
  data:      $DATA_DIR
  workspace: $WORKSPACE_DIR
  web:       $BIND:$PORT
  mcp:       127.0.0.1:$MCP_PORT
EOF
  exit 0
fi

mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$WORKSPACE_DIR"

quote_env() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

upsert_env() {
  local key="$1" value="$2" tmp
  tmp="$ENV_FILE.tmp"
  if [[ -f "$ENV_FILE" ]]; then
    awk -v key="$key" -v value="$value" '
      BEGIN { replaced = 0 }
      $0 ~ "^" key "=" { print key "=" value; replaced = 1; next }
      { print }
      END { if (!replaced) print key "=" value }
    ' "$ENV_FILE" > "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" > "$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

if [[ ! -f "$ENV_FILE" ]]; then
  chat_password="$(random_secret)"
  secrets_key="$(random_secret)"
  mcp_token="$(random_secret)"
  : > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  upsert_env APP_NAME "$(quote_env "Metis AI")"
  upsert_env CHAT_USERNAME "admin"
  upsert_env CHAT_PASSWORD "$(quote_env "$chat_password")"
  upsert_env AI_CHAT_SECRETS_KEY "$(quote_env "$secrets_key")"
  upsert_env MCP_BEARER_TOKEN "$(quote_env "$mcp_token")"
  upsert_env MCP_ALLOW_REMOTE_ADMIN "false"
  upsert_env MCP_ENABLE_REMOTE_SERVERS "false"
  upsert_env MCP_ENABLE_OPTIONAL_SERVERS "false"
fi

upsert_env METIS_IMAGE "$(quote_env "$IMAGE")"
upsert_env METIS_RELEASE_VERSION "$(quote_env "$VERSION")"
upsert_env METIS_DATA_DIR "$(quote_env "$DATA_DIR")"
upsert_env METIS_WORKSPACE "$(quote_env "$WORKSPACE_DIR")"
upsert_env PORT "$PORT"
upsert_env AI_CHAT_BIND "$(quote_env "$BIND")"
upsert_env MCP_PORT "$MCP_PORT"

cat > "$COMPOSE_FILE" <<'EOF'
services:
  app:
    image: ${METIS_IMAGE:?METIS_IMAGE is required}
    restart: unless-stopped
    env_file: .env
    environment:
      METIS_DOCKER: "1"
      AGENT_CWD: /workspace
      CHAT_DATA_DIR: /data
      AI_CHAT_ROOT: /app
      AI_CHAT_MCP_STATE_DIR: /data/mcp-state
      AI_CHAT_HOST: "0.0.0.0"
      PORT: "3100"
      AI_CHAT_INTERNAL_URL: http://app:3100/api/internal/mcp-question
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3100/').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    volumes:
      - ${METIS_DATA_DIR:?METIS_DATA_DIR is required}:/data
      - ${METIS_WORKSPACE:?METIS_WORKSPACE is required}:/workspace
    ports:
      - ${AI_CHAT_BIND:-127.0.0.1}:${PORT:-3100}:3100
    depends_on:
      worker:
        condition: service_started
      mcp:
        condition: service_started

  worker:
    image: ${METIS_IMAGE:?METIS_IMAGE is required}
    restart: unless-stopped
    command: ["pnpm", "exec", "tsx", "worker.ts"]
    env_file: .env
    environment:
      METIS_DOCKER: "1"
      AGENT_CWD: /workspace
      CHAT_DATA_DIR: /data
      AI_CHAT_ROOT: /app
      AI_CHAT_MCP_STATE_DIR: /data/mcp-state
      AI_CHAT_INTERNAL_URL: http://app:3100/api/internal/mcp-question
    volumes:
      - ${METIS_DATA_DIR:?METIS_DATA_DIR is required}:/data
      - ${METIS_WORKSPACE:?METIS_WORKSPACE is required}:/workspace
    depends_on:
      - mcp

  mcp:
    image: ${METIS_IMAGE:?METIS_IMAGE is required}
    restart: unless-stopped
    command: ["node", "lib/mcp-core/gateway-core.mjs"]
    env_file: .env
    environment:
      METIS_DOCKER: "1"
      AGENT_CWD: /workspace
      CHAT_DATA_DIR: /data
      AI_CHAT_ROOT: /app
      AI_CHAT_MCP_STATE_DIR: /data/mcp-state
      MCP_PORT: "8787"
      AI_CHAT_INTERNAL_URL: http://app:3100/api/internal/mcp-question
    volumes:
      - ${METIS_DATA_DIR:?METIS_DATA_DIR is required}:/data
      - ${METIS_WORKSPACE:?METIS_WORKSPACE is required}:/workspace
    ports:
      - 127.0.0.1:${MCP_PORT:-8787}:8787
EOF

compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" pull
compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --remove-orphans

for attempt in $(seq 1 60); do
  if curl --fail --silent --max-time 2 "http://${BIND}:${PORT}/" >/dev/null 2>&1 || curl --fail --silent --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    break
  fi
  [[ "$attempt" -eq 60 ]] && { compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs --tail=80 app >&2 || true; fail "Metis did not become healthy on port $PORT."; }
  sleep 2
done

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [[ -f "$MANIFEST_FILE" ]]; then
  created_at="$(sed -n 's/.*"createdAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST_FILE" | head -1)"
else
  created_at="$now"
fi
cat > "$MANIFEST_FILE" <<EOF
{
  "schemaVersion": 1,
  "installMethod": "docker",
  "image": "$(printf '%s' "$IMAGE" | sed 's/"/\\"/g')",
  "version": "$(printf '%s' "$VERSION" | sed 's/"/\\"/g')",
  "installDir": "$(printf '%s' "$INSTALL_DIR" | sed 's/"/\\"/g')",
  "dataDir": "$(printf '%s' "$DATA_DIR" | sed 's/"/\\"/g')",
  "workspaceDir": "$(printf '%s' "$WORKSPACE_DIR" | sed 's/"/\\"/g')",
  "createdAt": "${created_at:-$now}",
  "updatedAt": "$now"
}
EOF
chmod 600 "$MANIFEST_FILE"
printf 'Metis AI %s is running at http://%s:%s\n' "$VERSION" "$BIND" "$PORT"
printf 'Install manifest: %s\n' "$MANIFEST_FILE"
printf 'Upgrade: rerun this installer with --version vX.Y.Z or --version latest\n'
