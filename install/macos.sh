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
  macos.sh uninstall [options]              Uninstall Metis AI (same flags as uninstall-macos.sh)

Options:
  --install-dir DIR       Application checkout (default: ~/metis-ai)
  --data-dir DIR          Runtime data directory (default: INSTALL_DIR/data)
  --agent-cwd DIR         Agent workspace (default: $HOME)
  --port PORT             Web port (default: 3100)
  --host HOST             Bind address (default: 127.0.0.1)
  --mcp-port PORT         MCP gateway port (default: 8787)
     --service-name NAME     launchd service prefix (default: metis-ai)
  --public-url URL        URL shown to users
  --version TAG          Checkout a release tag such as v1.0.0 after clone/pull
  --native                Force Node.js + launchd instead of Docker
  --replace-existing     Uninstall a detected existing install (keeps data), then continue
  --non-interactive       Never read prompts; all values come from arguments/defaults
  --dry-run               Collect configuration and print the plan, then exit
  -h, --help              Show this help
EOF
}

non_interactive=0
dry_run=0
install_dir="$DEFAULT_DIR"
data_dir=""
data_dir_set=0
agent_cwd="$HOME"
port="3100"
ai_chat_host=""
mcp_port="8787"
service_name="metis-ai"
public_url=""
force_native=0
replace_existing=0
REPLACE_DATA_STASH=""
release_version=""

if [[ "${1:-}" == "uninstall" ]]; then
  shift
  uninstall_dir=""
  uninstall_svc="$service_name"
  args=("$@")
  i=0
  uninstall_help=0
  while [[ $i -lt ${#args[@]} ]]; do
    case "${args[$i]}" in
      --install-dir)
        uninstall_dir="${args[$((i+1))]:-}"
        i=$((i+2))
        ;;
      --service-name)
        uninstall_svc="${args[$((i+1))]:-$uninstall_svc}"
        i=$((i+2))
        ;;
      -h|--help)
        uninstall_help=1
        i=$((i+1))
        ;;
      *)
        i=$((i+1))
        ;;
    esac
  done
  if (( uninstall_help == 0 )); then
    if [[ -z "$uninstall_dir" ]]; then
      if [[ ! -f "$HOME/Library/LaunchAgents/${uninstall_svc}-app.plist" ]]; then
        die "Metis AI is not installed as ${uninstall_svc}-app. Nothing to uninstall."
      fi
    elif [[ ! -e "$uninstall_dir/.metis-ai-install.json" && ! -e "$uninstall_dir/.env" && ! -e "$uninstall_dir/server.mjs" ]]; then
      die "No Metis AI install found at $uninstall_dir. Nothing to uninstall."
    fi
  fi
  self_dir="$(cd "$(dirname "$0")" && pwd)"
  uninstall_script=""
  if [[ -f "$self_dir/uninstall-macos.sh" ]]; then
    uninstall_script="$self_dir/uninstall-macos.sh"
  elif [[ -f "$self_dir/install/uninstall-macos.sh" ]]; then
    uninstall_script="$self_dir/install/uninstall-macos.sh"
  else
    base="${METIS_AI_INSTALL_BASE:-https://raw.githubusercontent.com/f1shyondrugs/metis-ai/master}"
    base="${base%/}"
    uninstall_script="$(mktemp "${TMPDIR:-/tmp}/metis-ai-uninstall.XXXXXX")"
    curl -fsSL "$base/install/uninstall-macos.sh" -o "$uninstall_script" || die "failed to download the Metis AI uninstaller."
    chmod u+x "$uninstall_script"
  fi
  exec /bin/bash "$uninstall_script" "$@"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir) [[ $# -ge 2 ]] || die "--install-dir requires a value"; install_dir="$2"; shift 2 ;;
    --data-dir) [[ $# -ge 2 ]] || die "--data-dir requires a value"; data_dir="$2"; data_dir_set=1; shift 2 ;;
    --agent-cwd) [[ $# -ge 2 ]] || die "--agent-cwd requires a value"; agent_cwd="$2"; shift 2 ;;
    --port) [[ $# -ge 2 ]] || die "--port requires a value"; port="$2"; shift 2 ;;
    --host) [[ $# -ge 2 ]] || die "--host requires a value"; ai_chat_host="$2"; shift 2 ;;
    --mcp-port) [[ $# -ge 2 ]] || die "--mcp-port requires a value"; mcp_port="$2"; shift 2 ;;
             --service-name) [[ $# -ge 2 ]] || die "--service-name requires a value"; service_name="$2"; shift 2 ;;
    --public-url) [[ $# -ge 2 ]] || die "--public-url requires a value"; public_url="$2"; shift 2 ;;
    --version) [[ $# -ge 2 ]] || die "--version requires a value"; release_version="$2"; shift 2 ;;
    --native) force_native=1; shift ;;
    --replace-existing) replace_existing=1; shift ;;
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
[[ "$mcp_port" =~ ^[0-9]+$ && "$mcp_port" -ge 1 && "$mcp_port" -le 65535 ]] || die "MCP port must be a number between 1 and 65535."
[[ "$service_name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || die "Service name may contain letters, numbers, underscores and hyphens."
if [[ -n "$release_version" && "$release_version" != "latest" ]]; then
  [[ "$release_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "Version must be latest or a v-prefixed SemVer tag, for example v1.0.0."
fi

existing_service_state=""
existing_service_dir=""
existing_plist="$HOME/Library/LaunchAgents/${service_name}-app.plist"
if [[ -f "$existing_plist" ]]; then
  existing_service_state="launch-agent"
  existing_service_dir="$(sed -n '/<key>WorkingDirectory<\/key>/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$existing_plist")"
fi

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
  version:       ${release_version:-current branch}
  native:        $force_native
  existing:      ${existing_service_state:-none}${existing_service_dir:+ at $existing_service_dir}
EOF
  exit 0
fi

read_tty_line() {
  local prompt="$1"
  if [[ -t 0 ]]; then
    IFS= read -r -p "$prompt" REPLY
  elif [[ -r /dev/tty ]]; then
    IFS= read -r -p "$prompt" REPLY < /dev/tty
  else
    REPLY=""
  fi
}

abspath() {
  python3 -c 'import os,sys; print(os.path.abspath(os.path.expanduser(sys.argv[1])))' "$1"
}

read_existing_data_dir() {
  local dir="$1" value=""
  if [[ -f "$dir/.env" ]]; then
    value="$(awk -F= '/^CHAT_DATA_DIR=/{sub(/^CHAT_DATA_DIR=/, ""); gsub(/^"|"$/, ""); print; exit}' "$dir/.env")"
  fi
  if [[ -z "$value" && -f "$dir/.metis-ai-install.json" ]] && command -v python3 >/dev/null 2>&1; then
    value="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("dataDir",""))' "$dir/.metis-ai-install.json" 2>/dev/null || true)"
  fi
  if [[ -z "$value" && -d "$dir/data" ]]; then
    value="$dir/data"
  fi
  printf '%s' "$value"
}

path_is_inside() {
  local inner outer
  inner="$(abspath "$1")"
  outer="$(abspath "$2")"
  [[ "$inner" == "$outer" || "$inner" == "$outer"/* ]]
}

stop_macos_units() {
  local name="$1" suffix
  for suffix in app worker mcp; do
    launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/${name}-${suffix}.plist" >/dev/null 2>&1 || true
    rm -f "$HOME/Library/LaunchAgents/${name}-${suffix}.plist"
  done
}

stash_nested_data() {
  local dir="$1" data="$2"
  REPLACE_DATA_STASH=""
  [[ -n "$data" && -e "$data" ]] || return 0
  if path_is_inside "$data" "$dir"; then
    REPLACE_DATA_STASH="$(dirname "$(abspath "$dir")")/.$(basename "$dir").metis-keep-data"
    rm -rf -- "$REPLACE_DATA_STASH"
    mv -- "$data" "$REPLACE_DATA_STASH"
    printf 'Kept nested data at %s\n' "$REPLACE_DATA_STASH"
  fi
}

restore_stashed_data() {
  local dest="$1"
  [[ -n "${REPLACE_DATA_STASH:-}" && -e "$REPLACE_DATA_STASH" ]] || return 0
  mkdir -p "$(dirname "$dest")"
  if [[ -e "$dest" ]]; then
    rm -rf -- "$dest"
  fi
  mv -- "$REPLACE_DATA_STASH" "$dest"
  REPLACE_DATA_STASH=""
  printf 'Restored kept data to %s\n' "$dest"
}

REPLACE_ENV_STASH=""

env_stash_path() {
  local dir="$1" resolved
  resolved="$(abspath "$dir")"
  printf '%s/.%s.metis-keep-env' "$(dirname "$resolved")" "$(basename "$resolved")"
}

preserve_existing_env() {
  local dir="$1" src="$dir/.env"
  [[ -f "$src" ]] || return 0
  REPLACE_ENV_STASH="$(env_stash_path "$dir")"
  cp -a -- "$src" "$REPLACE_ENV_STASH"
  chmod 600 "$REPLACE_ENV_STASH"
  printf 'Kept previous .env at %s\n' "$REPLACE_ENV_STASH"
}

adopt_env_stash() {
  local dir="$1" candidate
  [[ -n "${REPLACE_ENV_STASH:-}" && -f "$REPLACE_ENV_STASH" ]] && return 0
  candidate="$(env_stash_path "$dir")"
  if [[ -f "$candidate" ]]; then
    REPLACE_ENV_STASH="$candidate"
    return 0
  fi
  preserve_existing_env "$dir"
}

merge_preserved_env() {
  local dest="$1" preserved="${REPLACE_ENV_STASH:-}" tmp
  [[ -n "$preserved" && -f "$preserved" && -f "$dest" ]] || return 0
  tmp="$dest.tmp"
  # METIS_ENV_MERGE_BEGIN
  awk -v preserved="$preserved" '
    function key_of(line,   k) {
      if (line ~ /^[ \t]*#/ || line ~ /^[ \t]*$/) return ""
      k = line
      sub(/\r$/, "", k)
      if (index(k, "=") == 0) return ""
      sub(/=.*/, "", k)
      return k
    }
    function is_structural(k) {
      return (k == "AI_CHAT_ROOT" || k == "AI_CHAT_INSTALL_DIR" || k == "METIS_NODE_BIN" || k == "METIS_NODE_HOME" || k == "CHAT_DATA_DIR" || k == "METIS_DATA_DIR" || k == "AGENT_CWD" || k == "METIS_WORKSPACE" || k == "AI_CHAT_MCP_STATE_DIR" || k == "METIS_DOCKER" || k == "AI_CHAT_SERVICE_NAME")
    }
    BEGIN {
      while ((getline line < preserved) > 0) {
        k = key_of(line)
        if (k != "") {
          old[k] = line
          if (!(k in seen_old)) {
            seen_old[k] = 1
            old_order[++n] = k
          }
        }
      }
      close(preserved)
    }
    {
      k = key_of($0)
      if (k != "" && !is_structural(k) && (k in old)) {
        print old[k]
        used[k] = 1
      } else {
        print $0
        if (k != "") used[k] = 1
      }
    }
    END {
      for (i = 1; i <= n; i++) {
        k = old_order[i]
        if (!(k in used) && !is_structural(k)) print old[k]
      }
    }
  ' "$dest" > "$tmp"
  # METIS_ENV_MERGE_END
  mv "$tmp" "$dest"
  chmod 600 "$dest"
  rm -f -- "$preserved"
  REPLACE_ENV_STASH=""
  printf 'Merged previous .env into %s (old values kept, new keys added).\n' "$dest"
}

read_env_key() {
  local file="$1" key="$2"
  awk -v key="$key" '
    index($0, key "=") == 1 {
      val = substr($0, length(key) + 2)
      gsub(/\r/, "", val)
      gsub(/^"/, "", val)
      gsub(/"$/, "", val)
      print val
      exit
    }
  ' "$file"
}

upsert_env_key() {
  local dest="$1" key="$2" value="$3" tmp line
  line="$(write_env_line "$key" "$value" | tr -d '\n')"
  tmp="$dest.tmp"
  awk -v key="$key" -v line="$line" '
    BEGIN { replaced = 0 }
    $0 ~ "^" key "=" { print line; replaced = 1; next }
    { print }
    END { if (!replaced) print line }
  ' "$dest" > "$tmp"
  mv "$tmp" "$dest"
  chmod 600 "$dest"
}

apply_merged_runtime_ports() {
  local dest="$1" value next
  [[ -f "$dest" ]] || return 0
  value="$(read_env_key "$dest" PORT)"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    port="$value"
  fi
  value="$(read_env_key "$dest" MCP_PORT)"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    mcp_port="$value"
  fi
  if port_in_use "$mcp_port"; then
    if curl --fail --silent --max-time 2 "http://127.0.0.1:${mcp_port}/health" >/dev/null 2>&1; then
      return 0
    fi
    next="$(pick_free_port "$mcp_port")"
    if [[ "$next" == "$mcp_port" ]]; then
      return 0
    fi
    printf 'Preserved MCP port %s is in use; using %s instead.\n' "$mcp_port" "$next"
    mcp_port="$next"
    upsert_env_key "$dest" MCP_PORT "$mcp_port"
    upsert_env_key "$dest" MCP_PUBLIC_URL "http://127.0.0.1:$mcp_port"
  fi
}

uninstall_detected_install() {
  local dir="$1" data=""
  [[ -n "$dir" && "$dir" != "/" && "$dir" != "$HOME" ]] || die "Refusing to uninstall an unsafe install directory: ${dir:-unknown}"
  printf 'Uninstalling existing Metis AI at %s (data kept).\n' "$dir"
  data="$(read_existing_data_dir "$dir")"
  stop_macos_units "$service_name"
  preserve_existing_env "$dir"
  stash_nested_data "$dir" "$data"
  rm -rf -- "$dir"
}

if [[ -n "$existing_service_state" ]]; then
  same=0
  [[ -n "$existing_service_dir" && "$existing_service_dir" == "$install_dir" ]] && same=1
  choice=""
  if (( replace_existing )); then
    choice=r
  elif (( non_interactive )); then
    if (( same )); then choice=u; fi
  else
    printf 'Existing Metis AI detected.\n'
    printf '  service:   %s-app (%s)\n' "$service_name" "$existing_service_state"
    printf '  directory: %s\n' "${existing_service_dir:-unknown}"
    printf '[u] Upgrade that install\n[r] Replace it (uninstall, keep data, then continue)\n[n] Uninstall and exit (keeps data)\n[a] Abort\n'
    read_tty_line "Choice [u/r/n/a]: "
    choice="$REPLY"
  fi
  case "$choice" in
    r|R)
      install_dir="${existing_service_dir:-$install_dir}"
      if (( data_dir_set == 0 )); then
        data_dir="$install_dir/data"
      fi
      uninstall_detected_install "$install_dir"
      existing_service_state=""
      existing_service_dir=""
      ;;
    u|U)
      if [[ -n "$existing_service_dir" ]]; then
        install_dir="$existing_service_dir"
      fi
      printf 'Existing Metis AI install detected: %s-app is registered in %s. Upgrading in place.\n' \
        "$service_name" "$install_dir"
      ;;
    a|A)
      printf 'Aborted.\n'
      exit 0
      ;;
    n|N)
      install_dir="${existing_service_dir:-$install_dir}"
      [[ -n "$install_dir" && "$install_dir" != "/" && "$install_dir" != "$HOME" ]] || die "Could not resolve the install directory to uninstall."
      if (( dry_run )); then
        printf 'Would uninstall Metis AI at %s (data kept) and exit.\n' "$install_dir"
        exit 0
      fi
      exec /bin/bash "$0" uninstall --install-dir "$install_dir" --service-name "$service_name" --yes --keep-data
      ;;
    *)
      die "Metis AI is already installed as ${service_name}-app in ${existing_service_dir:-an unknown directory}. Re-run and choose upgrade/replace/uninstall, or pass --replace-existing."
      ;;
  esac
fi

mcp_port="$(pick_free_port "$mcp_port")"
[[ "$mcp_port" =~ ^[0-9]+$ && "$mcp_port" -ge 1 && "$mcp_port" -le 65535 ]] || die "MCP port must be a number between 1 and 65535."

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
if [[ -n "$release_version" && "$release_version" != "latest" ]]; then
  git -C "$install_dir" fetch --tags --force
  git -C "$install_dir" checkout --force "$release_version"
fi

restore_stashed_data "$data_dir"

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
adopt_env_stash "$install_dir"
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
merge_preserved_env "$install_dir/.env"
apply_merged_runtime_ports "$install_dir/.env"

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
