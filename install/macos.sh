#!/usr/bin/env bash
# Metis AI macOS installer. Run as a file, not via `curl | bash`.
# Prefer: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/f1shyondrugs/metis-ai/master/install.sh)"
set -Eeuo pipefail

REPO_URL="${METIS_AI_REPO_URL:-https://github.com/f1shyondrugs/metis-ai.git}"
DEFAULT_DIR="${METIS_AI_INSTALL_DIR:-$HOME/metis-ai}"

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

confirm_install() {
  local name="$1" answer
  (( non_interactive )) && return 0

  if [[ -t 0 ]]; then
    IFS= read -r -p "$name is missing or too old. Install/update it automatically? [Y/n] " answer
  else
    IFS= read -r -p "$name is missing or too old. Install/update it automatically? [Y/n] " answer < /dev/tty
  fi
  [[ -z "$answer" || "$answer" =~ ^([Yy][Ee][Ss]|[Yy])$ ]]
}

version_at_least_22() {
  command -v "$1" >/dev/null 2>&1 &&
    [[ "$("$1" -p 'process.versions.node.split(".")[0]')" -ge 22 ]]
}

write_env_line() {
  local key="$1" value="$2"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\\$}"
  printf '%s="%s"\n' "$key" "$value"
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  printf '%s' "$value"
}

json_str() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

wait_for_health() {
  local url="$1" attempt
  for attempt in $(seq 1 30); do
    if curl --fail --silent --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

port_in_use() {
  local p="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1
  else
    (echo >/dev/tcp/127.0.0.1/"$p") >/dev/null 2>&1
  fi
}

pick_free_port() {
  local p="$1"
  if ! port_in_use "$p"; then printf '%s' "$p"; return; fi
  local candidate
  for candidate in 8798 8799 8800 8801 8802 8788 8789; do
    if ! port_in_use "$candidate"; then printf '%s' "$candidate"; return; fi
  done
  printf '%s' "$p"
}

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  else docker-compose "$@"
  fi
}

usage() {
  cat <<'EOF'
Usage:
  macos.sh                                  Install Metis AI without account prompts
  macos.sh --non-interactive Install without prompts (default)

Options:
  --install-dir DIR       Application checkout (default: ~/metis-ai)
  --data-dir DIR          Runtime data directory (default: INSTALL_DIR/data)
  --agent-cwd DIR         Agent workspace (default: $HOME)
  --port PORT             Web port (default: 3100)
  --host HOST             Bind address (default: 127.0.0.1)
  --mcp-port PORT         MCP gateway port (default: 8787)
     --service-name NAME     launchd service prefix (default: metis-ai)
  --public-url URL        URL shown to users
  --native                Force Node.js + launchd instead of Docker
  --non-interactive       Never read prompts; all values come from arguments/defaults
  --dry-run               Collect configuration and print the plan, then exit
  -h, --help              Show this help
EOF
}

non_interactive=0
dry_run=0
install_dir="$DEFAULT_DIR"
data_dir=""
agent_cwd="$HOME"
port="3100"
ai_chat_host=""
mcp_port="8787"
service_name="metis-ai"
public_url=""
force_native=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir) [[ $# -ge 2 ]] || die "--install-dir requires a value"; install_dir="$2"; shift 2 ;;
    --data-dir) [[ $# -ge 2 ]] || die "--data-dir requires a value"; data_dir="$2"; shift 2 ;;
    --agent-cwd) [[ $# -ge 2 ]] || die "--agent-cwd requires a value"; agent_cwd="$2"; shift 2 ;;
    --port) [[ $# -ge 2 ]] || die "--port requires a value"; port="$2"; shift 2 ;;
    --host) [[ $# -ge 2 ]] || die "--host requires a value"; ai_chat_host="$2"; shift 2 ;;
    --mcp-port) [[ $# -ge 2 ]] || die "--mcp-port requires a value"; mcp_port="$2"; shift 2 ;;
             --service-name) [[ $# -ge 2 ]] || die "--service-name requires a value"; service_name="$2"; shift 2 ;;
    --public-url) [[ $# -ge 2 ]] || die "--public-url requires a value"; public_url="$2"; shift 2 ;;
    --native) force_native=1; shift ;;
    --non-interactive) non_interactive=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (use --help for usage)" ;;
  esac
done

install_dir="${install_dir/#\~/$HOME}"
agent_cwd="${agent_cwd/#\~/$HOME}"
data_dir="${data_dir/#\~/$HOME}"


default_public_host() {
  local host
  host="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  printf '%s' "${host:-127.0.0.1}"
}

ai_chat_host="${ai_chat_host:-127.0.0.1}"
data_dir="${data_dir:-$install_dir/data}"

data_dir="${data_dir:-$install_dir/data}"
if [[ "$ai_chat_host" == "0.0.0.0" ]]; then
  public_host="$(default_public_host)"
else
  public_host="127.0.0.1"
fi
public_url="${public_url:-http://${public_host}:${port}}"

[[ "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]] || die "Web port must be a number between 1 and 65535."
mcp_port="$(pick_free_port "$mcp_port")"
[[ "$mcp_port" =~ ^[0-9]+$ && "$mcp_port" -ge 1 && "$mcp_port" -le 65535 ]] || die "MCP port must be a number between 1 and 65535."
[[ "$service_name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || die "Service name may contain letters, numbers, underscores and hyphens."

if (( dry_run )); then
  cat <<EOF
Dry run; no files or services will be changed.
  os:            macos
  install dir:   $install_dir
  data dir:      $data_dir
  agent cwd:     $agent_cwd
  bind:          $ai_chat_host:$port
  mcp port:      $mcp_port
  service name:  $service_name
  public url:    $public_url
  native:        $force_native
EOF
  exit 0
fi

install_homebrew() {
  command -v brew >/dev/null 2>&1 && return 0
  confirm_install "Homebrew" || die "Homebrew is required."
  command -v curl >/dev/null 2>&1 || die "curl is required to install Homebrew automatically."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  command -v brew >/dev/null 2>&1 || die "Homebrew installation completed but brew is not available."
}

install_homebrew
command -v git >/dev/null 2>&1 || { confirm_install "git" && brew install git || die "git is required."; }

if [[ -e "$install_dir/.git" ]]; then
  git -C "$install_dir" pull --ff-only
elif [[ -e "$install_dir" && -n "$(ls -A "$install_dir" 2>/dev/null)" ]]; then
  die "Installation directory exists and is not an existing Metis AI checkout."
else
  mkdir -p "$(dirname "$install_dir")"
  git clone "$REPO_URL" "$install_dir"
fi

use_docker=0
if (( force_native == 0 )) && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1; then
    use_docker=1
  fi
fi

if (( use_docker == 0 )); then
  if ! version_at_least_22 node; then
    confirm_install "Node.js 22 or newer" || die "Node.js 22 or newer is required."
    if command -v node >/dev/null 2>&1; then brew upgrade node || true; else brew install node; fi
  fi
  version_at_least_22 node || die "Node.js 22 or newer is required after installation."
  command -v pnpm >/dev/null 2>&1 || { confirm_install "pnpm" && brew install pnpm || die "pnpm is required."; }
fi

node_bin="$(command -v node || true)"
node_home=""
if [[ -n "$node_bin" ]]; then
  node_home="$(dirname "$(dirname "$node_bin")")"
fi
secrets_key="$(openssl rand -hex 32)"
mcp_token="$(openssl rand -hex 32)"

mkdir -p "$data_dir" "$agent_cwd"
{
  write_env_line APP_NAME "Metis AI"
  write_env_line PORT "$port"
  write_env_line AI_CHAT_HOST "$ai_chat_host"
  write_env_line CHAT_DATA_DIR "$data_dir"
  write_env_line AGENT_CWD "$agent_cwd"
  write_env_line AI_CHAT_ROOT "$install_dir"
  write_env_line AI_CHAT_INSTALL_DIR "$install_dir"
  write_env_line AI_CHAT_PUBLIC_URL "$public_url"
  write_env_line AI_CHAT_SERVICE_NAME "$service_name"
  write_env_line AI_CHAT_WORKER_CONCURRENCY "25"
  write_env_line AI_CHAT_MCP_STATE_DIR "$data_dir/mcp-state"
  write_env_line AI_CHAT_SECRETS_KEY "$secrets_key"
  write_env_line MCP_PORT "$mcp_port"
  write_env_line MCP_PUBLIC_URL "http://127.0.0.1:$mcp_port"
  write_env_line AI_CHAT_INTERNAL_URL "http://127.0.0.1:$port/api/internal/mcp-question"
  write_env_line MCP_BEARER_TOKEN "$mcp_token"
  printf 'MCP_ALLOW_REMOTE_ADMIN=false\n'
  printf 'MCP_ENABLE_REMOTE_SERVERS=false\n'
  printf 'MCP_ENABLE_OPTIONAL_SERVERS=false\n'
  write_env_line METIS_WORKSPACE "$agent_cwd"
  write_env_line METIS_DATA_DIR "$data_dir"
  write_env_line AI_CHAT_BIND "$ai_chat_host"
  if (( use_docker )); then
    printf 'METIS_DOCKER=1\n'
    write_env_line AGENT_CWD "/workspace"
    write_env_line CHAT_DATA_DIR "/data"
           else
    write_env_line METIS_NODE_BIN "$node_bin"
    write_env_line METIS_NODE_HOME "$node_home"
  fi
} > "$install_dir/.env"
chmod 600 "$install_dir/.env"

if (( use_docker )); then
  (
    cd "$install_dir"
    compose up -d --build
  )
else
cat > "$install_dir/run-service.sh" <<'EOF'
#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a
export PATH="${METIS_NODE_HOME:+$METIS_NODE_HOME/bin:}$ROOT/node_modules/.bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin${PATH:+:$PATH}"
cd "$ROOT"
exec "${METIS_NODE_BIN:?METIS_NODE_BIN is missing from .env}" "$@"
EOF
chmod 700 "$install_dir/run-service.sh"

(
  unset NODE_ENV
  set -a
  # shellcheck disable=SC1091
  . "$install_dir/.env"
  set +a
  cd "$install_dir"
  pnpm install --frozen-lockfile
  pnpm build
)

launch_dir="$HOME/Library/LaunchAgents"
mkdir -p "$launch_dir"
write_plist() {
  local suffix label
  suffix="$1"
  shift
  label="${service_name}-${suffix}"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0"><dict>'
    printf '  <key>Label</key><string>%s</string>\n' "$(xml_escape "$label")"
    printf '  <key>ProgramArguments</key><array>\n'
    printf '    <string>%s</string>\n' "$(xml_escape "$install_dir/run-service.sh")"
    local arg
    for arg in "$@"; do
      printf '    <string>%s</string>\n' "$(xml_escape "$arg")"
    done
    printf '  </array>\n'
    printf '  <key>WorkingDirectory</key><string>%s</string>\n' "$(xml_escape "$install_dir")"
    printf '  <key>EnvironmentVariables</key><dict>\n'
    printf '    <key>HOME</key><string>%s</string>\n' "$(xml_escape "$HOME")"
    printf '    <key>PATH</key><string>%s</string>\n' "$(xml_escape "$node_home/bin:$install_dir/node_modules/.bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")"
    printf '  </dict>\n'
    printf '  <key>RunAtLoad</key><true/>\n'
    printf '  <key>KeepAlive</key><true/>\n'
    printf '  <key>StandardOutPath</key><string>%s</string>\n' "$(xml_escape "$data_dir/$label.log")"
    printf '  <key>StandardErrorPath</key><string>%s</string>\n' "$(xml_escape "$data_dir/$label.error.log")"
    printf '%s\n' '</dict></plist>'
  } > "$launch_dir/$label.plist"
  launchctl bootout "gui/$(id -u)" "$launch_dir/$label.plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$launch_dir/$label.plist"
}
write_plist app "$install_dir/node_modules/tsx/dist/cli.mjs" "$install_dir/server.mjs"
write_plist worker "$install_dir/node_modules/tsx/dist/cli.mjs" "$install_dir/worker.ts"
write_plist mcp "$install_dir/lib/mcp-core/gateway-core.mjs"
fi
wait_for_health "http://127.0.0.1:$port/api/status" ||
  die "The application did not become healthy. Check launchctl, docker compose logs, or the service logs."
wait_for_health "http://127.0.0.1:$mcp_port/health" ||
  die "The MCP gateway did not become healthy on port $mcp_port."

install_method="native"
if (( use_docker )); then install_method="docker"; fi
{
  printf '{'
  printf '"installDir":%s,' "$(json_str "$install_dir")"
  printf '"dataDir":%s,' "$(json_str "$data_dir")"
  printf '"agentCwd":%s,' "$(json_str "$agent_cwd")"
  printf '"serviceName":%s,' "$(json_str "$service_name")"
  printf '"host":%s,' "$(json_str "$ai_chat_host")"
  printf '"os":"macos",'
  printf '"installMethod":%s,' "$(json_str "$install_method")"
  printf '"createdAt":%s' "$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
  printf '}\n'
} > "$install_dir/.metis-ai-install.json"
chmod 600 "$install_dir/.metis-ai-install.json"
cp "$install_dir/install/uninstall-macos.sh" "$install_dir/uninstall-macos.sh"
chmod 700 "$install_dir/uninstall-macos.sh"
if [[ "$ai_chat_host" == "0.0.0.0" ]]; then
  printf 'Warning: the web application is reachable on the local network. Use strong credentials and a firewall or trusted TLS reverse proxy.\n'
fi
printf '\nMetis AI installed successfully.\nOpen: %s\nUninstall: %s --install-dir %q --keep-data\n' \
  "$public_url" "$install_dir/uninstall-macos.sh" "$install_dir"
