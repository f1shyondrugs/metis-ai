#!/usr/bin/env bash
set -Eeuo pipefail
KEEP_DATA=false
DRY_RUN=false
YES=false
INSTALL_DIR="${METIS_AI_INSTALL_DIR:-}"
SERVICE_NAME="${METIS_AI_SERVICE_NAME:-metis-ai}"

discover_install_dir() {
  local service="$1" plist dir
  plist="$HOME/Library/LaunchAgents/${service}-app.plist"
  [[ -f "$plist" ]] || return 1
  dir="$(sed -n '/<key>WorkingDirectory<\/key>/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$plist")"
  [[ -n "$dir" && "$dir" != "/" && "$dir" != "$HOME" ]] || return 1
  printf '%s' "$dir"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --service-name) SERVICE_NAME="${2:-}"; shift 2 ;;
    --keep-data) KEEP_DATA=true; shift ;;
    --remove-data) KEEP_DATA=false; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --yes) YES=true; shift ;;
    -h|--help) echo "Usage: uninstall-macos.sh [--install-dir DIR] [--service-name NAME] [--keep-data|--remove-data] [--dry-run] [--yes]"; echo "If --install-dir is omitted, the directory is read from the ${SERVICE_NAME}-app LaunchAgent."; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$INSTALL_DIR" ]]; then
  INSTALL_DIR="$(discover_install_dir "$SERVICE_NAME" || true)"
fi
[[ -n "$INSTALL_DIR" ]] || { echo "Could not detect the install directory from ${SERVICE_NAME}-app. Pass --install-dir DIR." >&2; exit 2; }
MANIFEST="$INSTALL_DIR/.metis-ai-install.json"
SERVICE="$SERVICE_NAME"
DATA_DIR=""
INSTALL_METHOD="native"
if [[ -f "$MANIFEST" ]]; then
IFS=$'\t' read -r SERVICE DATA_DIR INSTALL_METHOD < <(python3 - "$MANIFEST" <<'PY'
import json, sys
data=json.load(open(sys.argv[1]))
print(data.get("serviceName", "metis-ai"), data.get("dataDir", ""), data.get("installMethod", "native"), sep="\t")
PY
)
fi
[[ "$INSTALL_DIR" != "/" && "$INSTALL_DIR" != "$HOME" ]] || { echo "Refusing to remove unsafe install directory." >&2; exit 1; }
if [[ "$YES" != true ]]; then
  read -r -p "Remove Metis AI installation at $INSTALL_DIR? Type 'yes': " answer
  [[ "$answer" == "yes" ]] || { echo "Aborted."; exit 0; }
fi
run() { if [[ "$DRY_RUN" == true ]]; then printf '+ %s\n' "$*"; else "$@"; fi; }

abspath() {
  python3 -c 'import os,sys; print(os.path.abspath(os.path.expanduser(sys.argv[1])))' "$1"
}

KEEP_STASH=""
KEEP_ENV_STASH=""
stash_keep_env() {
  [[ "$KEEP_DATA" == true ]] || return 0
  [[ -f "$INSTALL_DIR/.env" ]] || return 0
  local install_real
  install_real="$(abspath "$INSTALL_DIR")"
  KEEP_ENV_STASH="$(dirname "$install_real")/.$(basename "$install_real").metis-keep-env"
  if [[ "$DRY_RUN" == true ]]; then
    printf '+ cp %s %s\n' "$INSTALL_DIR/.env" "$KEEP_ENV_STASH"
  else
    cp -a -- "$INSTALL_DIR/.env" "$KEEP_ENV_STASH"
    chmod 600 "$KEEP_ENV_STASH"
  fi
}
stash_nested_keep_data() {
  [[ "$KEEP_DATA" == true ]] || return 0
  if [[ -z "$DATA_DIR" && -f "$INSTALL_DIR/.env" ]]; then
    DATA_DIR="$(awk -F= '/^CHAT_DATA_DIR=/{sub(/^CHAT_DATA_DIR=/, ""); gsub(/^"|"$/, ""); print; exit}' "$INSTALL_DIR/.env")"
  fi
  if [[ -z "$DATA_DIR" && -d "$INSTALL_DIR/data" ]]; then
    DATA_DIR="$INSTALL_DIR/data"
  fi
  [[ -n "$DATA_DIR" && -e "$DATA_DIR" ]] || return 0
  local data_real install_real
  data_real="$(abspath "$DATA_DIR")"
  install_real="$(abspath "$INSTALL_DIR")"
  if [[ "$data_real" == "$install_real" ]]; then
    echo "Refusing to remove the install directory because dataDir equals installDir." >&2
    exit 1
  fi
  case "$data_real" in
    "$install_real"/*)
      KEEP_STASH="${install_real}.metis-keep-data"
      if [[ "$DRY_RUN" == true ]]; then
        printf '+ mv %s %s\n' "$data_real" "$KEEP_STASH"
      else
        rm -rf -- "$KEEP_STASH"
        mv -- "$data_real" "$KEEP_STASH"
      fi
      ;;
  esac
}
if [[ "$INSTALL_METHOD" == "docker" ]]; then
  if command -v docker >/dev/null 2>&1; then
    (cd "$INSTALL_DIR" && { docker compose down >/dev/null 2>&1 || docker-compose down >/dev/null 2>&1 || true; })
  fi
else
for suffix in app worker mcp; do
  run launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/$SERVICE-$suffix.plist" >/dev/null 2>&1 || true
  run rm -f "$HOME/Library/LaunchAgents/$SERVICE-$suffix.plist"
done
fi
stash_nested_keep_data
stash_keep_env
if [[ "$KEEP_DATA" != true && -n "$DATA_DIR" && "$DATA_DIR" != "/" && "$DATA_DIR" != "$INSTALL_DIR" ]]; then
  run rm -rf -- "$DATA_DIR"
fi
run rm -rf -- "$INSTALL_DIR"
if [[ -n "$KEEP_STASH" || -n "$KEEP_ENV_STASH" ]]; then
  echo "Metis AI uninstalled. Data kept: ${KEEP_STASH:-$KEEP_DATA}; env kept: ${KEEP_ENV_STASH:-none}"
else
  echo "Metis AI uninstalled. Data kept: $KEEP_DATA"
fi
