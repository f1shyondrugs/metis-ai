#!/usr/bin/env bash
# Metis AI Linux installer. Run as a file, not via `curl | bash`.
# Prefer: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/f1shyondrugs/metis-ai/master/install.sh)"
set -Eeuo pipefail

APP_NAME="Metis AI"
REPO_URL="${METIS_AI_REPO_URL:-https://github.com/f1shyondrugs/metis-ai.git}"
NODE_VERSION="${METIS_NODE_VERSION:-22.16.0}"
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

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    command -v sudo >/dev/null 2>&1 || die "sudo is required to install system packages."
    sudo "$@"
  fi
}

install_system_package() {
  local package="$1"
  if command -v apt-get >/dev/null 2>&1; then
    run_privileged apt-get update && run_privileged apt-get install -y "$package"
  elif command -v dnf >/dev/null 2>&1; then
    run_privileged dnf install -y "$package"
  elif command -v yum >/dev/null 2>&1; then
    run_privileged yum install -y "$package"
  elif command -v pacman >/dev/null 2>&1; then
    run_privileged pacman -Sy --noconfirm "$package"
  else
    return 1
  fi
}

ensure_native_build_tools() {
  if command -v make >/dev/null 2>&1 && { command -v g++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1 || command -v c++ >/dev/null 2>&1; }; then
    return 0
  fi
  printf 'Installing C/C++ build tools required for native modules (node-pty)...\n'
  if command -v apt-get >/dev/null 2>&1; then
    run_privileged apt-get update
    run_privileged apt-get install -y build-essential python3
  elif command -v dnf >/dev/null 2>&1; then
    run_privileged dnf install -y gcc-c++ make python3
  elif command -v yum >/dev/null 2>&1; then
    run_privileged yum install -y gcc-c++ make python3
  elif command -v pacman >/dev/null 2>&1; then
    run_privileged pacman -Sy --noconfirm base-devel python
  else
    die "make and a C++ compiler are required. On Debian/Ubuntu run: apt-get install -y build-essential"
  fi
  command -v make >/dev/null 2>&1 || die "make is still missing after installing build tools."
}

write_env_line() {
  local key="$1" value="$2"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\\$}"
  printf '%s="%s"\n' "$key" "$value"
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
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -qE ":${p}[[:space:]]"
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
  linux.sh                                  Install Metis AI without account prompts
  linux.sh --non-interactive Install without prompts (default)

Options:
  --install-dir DIR       Application checkout (default: ~/metis-ai)
  --data-dir DIR          Runtime data directory (default: INSTALL_DIR/data)
  --agent-cwd DIR         Agent workspace (default: $HOME)
  --port PORT             Web port (default: 3100)
  --host HOST             Bind address (default: 127.0.0.1)
  --mcp-port PORT         MCP gateway port (default: 8787)
     --service-name NAME     systemd service prefix (default: metis-ai)
  --public-url URL        URL shown to users
  --native                Force Node.js + systemd instead of Docker
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
  host="$(hostname -I 2>/dev/null | awk '{print $1}')"
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
  os:            linux
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

version_at_least_22() {
  command -v "$1" >/dev/null 2>&1 || return 1
  [[ "$("$1" -p 'process.versions.node.split(".")[0]')" -ge 22 ]]
}

install_node() {
  local dir="$1/.runtime" arch url archive
  if version_at_least_22 node; then
    printf '%s' "$(command -v node)"
    return 0
  fi
  confirm_install "Node.js 22 or newer" || die "Node.js 22 or newer is required."
  mkdir -p "$dir"
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    *) die "Unsupported Linux architecture: $(uname -m)" ;;
  esac
  url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz"
  archive="$dir/node.tar.xz"
  if ! command -v curl >/dev/null 2>&1; then
    confirm_install "curl" && install_system_package curl ||
      die "curl is required to install Node.js automatically."
  fi
  curl -fsSL "$url" -o "$archive"
  tar -xJf "$archive" -C "$dir"
  rm -rf "$dir/node"
  mv "$dir/node-v${NODE_VERSION}-linux-${arch}" "$dir/node"
  rm -f "$archive"
  printf '%s' "$dir/node/bin/node"
}

if ! command -v git >/dev/null 2>&1; then
  confirm_install "git" && install_system_package git ||
    die "git is required."
fi
if [[ -e "$install_dir/.git" ]]; then
  git -C "$install_dir" pull --ff-only
elif [[ -e "$install_dir" && -n "$(ls -A "$install_dir" 2>/dev/null)" ]]; then
  die "Installation directory exists and is not an existing Metis AI checkout: $install_dir"
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

node_bin=""
node_home=""
if (( use_docker == 0 )); then
  node_bin="$(install_node "$install_dir")"
  node_home="$(dirname "$(dirname "$node_bin")")"
  export PATH="$node_home/bin:$install_dir/node_modules/.bin:$PATH"
  command -v corepack >/dev/null 2>&1 && corepack enable >/dev/null 2>&1 || true
  command -v pnpm >/dev/null 2>&1 || "$node_home/bin/npm" install --global pnpm@9
fi

rand_hex() {
  openssl rand -hex 32 2>/dev/null || {
    if [[ -n "$node_home" ]]; then
      "$node_home/bin/node" -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
    else
      die "openssl is required to generate secrets when installing with Docker."
    fi
  }
}
secrets_key="$(rand_hex)"
mcp_token="$(rand_hex)"

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
  write_env_line AI_CHAT_INTERNAL_URL "http://127.0.0.1:$port/api/internal/mcp-question"
  write_env_line AI_CHAT_SECRETS_KEY "$secrets_key"
  write_env_line MCP_PORT "$mcp_port"
  write_env_line MCP_PUBLIC_URL "http://127.0.0.1:$mcp_port"
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
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a
export PATH="${METIS_NODE_HOME:+$METIS_NODE_HOME/bin:}$ROOT/node_modules/.bin:/usr/local/bin:/usr/bin:/bin${PATH:+:$PATH}"
cd "$ROOT"
exec "${METIS_NODE_BIN:?METIS_NODE_BIN is missing from .env}" "$@"
EOF
chmod 700 "$install_dir/run-service.sh"

ensure_native_build_tools
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

if (( use_docker == 0 )) && command -v systemctl >/dev/null 2>&1; then
  command -v sudo >/dev/null 2>&1 || die "sudo is required to install system services."
  service_dir="/etc/systemd/system"
  write_unit() {
    local unit="$1" description="$2" exec_start arg
    shift 2
    exec_start="\"$install_dir/run-service.sh\""
    for arg in "$@"; do
      exec_start="$exec_start \"$arg\""
    done
    sudo tee "$service_dir/$unit" >/dev/null <<EOF
[Unit]
Description=$description
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
Group=$(id -gn)
WorkingDirectory=$install_dir
Environment=HOME=$HOME
Environment=NODE_ENV=production
ExecStart=$exec_start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  }
  write_unit "${service_name}.service" "Metis AI" "$install_dir/node_modules/tsx/dist/cli.mjs" "$install_dir/server.mjs"
  write_unit "${service_name}-worker.service" "Metis AI worker" "$install_dir/node_modules/tsx/dist/cli.mjs" "$install_dir/worker.ts"
  write_unit "${service_name}-mcp.service" "Metis AI MCP gateway" "$install_dir/lib/mcp-core/gateway-core.mjs"
  sudo systemctl daemon-reload
  sudo systemctl enable --now "${service_name}.service" "${service_name}-worker.service" "${service_name}-mcp.service"
fi
fi
if command -v curl >/dev/null 2>&1; then
  wait_for_health "http://127.0.0.1:$port/api/status" ||
    die "The application did not become healthy. Check systemctl status ${service_name}.service or docker compose logs."
  wait_for_health "http://127.0.0.1:$mcp_port/health" ||
    die "The MCP gateway did not become healthy on port $mcp_port."
fi

install_method="native"
if (( use_docker )); then install_method="docker"; fi
{
  printf '{'
  printf '"installDir":%s,' "$(json_str "$install_dir")"
  printf '"dataDir":%s,' "$(json_str "$data_dir")"
  printf '"agentCwd":%s,' "$(json_str "$agent_cwd")"
  printf '"serviceName":%s,' "$(json_str "$service_name")"
  printf '"host":%s,' "$(json_str "$ai_chat_host")"
  printf '"os":"linux",'
  printf '"installMethod":%s,' "$(json_str "$install_method")"
  printf '"createdAt":%s' "$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
  printf '}\n'
} > "$install_dir/.metis-ai-install.json"
chmod 600 "$install_dir/.metis-ai-install.json"
cp "$install_dir/install/uninstall.sh" "$install_dir/uninstall.sh"
chmod 700 "$install_dir/uninstall.sh"
if [[ "$ai_chat_host" == "0.0.0.0" ]]; then
  printf 'Warning: the web application is reachable on the local network. Use strong credentials and a firewall or trusted TLS reverse proxy.\n'
fi
printf '\n%s installed successfully.\nOpen: %s\nUninstall: %s --install-dir %q --keep-data\n' \
  "$APP_NAME" "$public_url" "$install_dir/uninstall.sh" "$install_dir"
