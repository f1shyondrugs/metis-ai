#!/usr/bin/env bash
set -Eeuo pipefail

KEEP_DATA=false
DRY_RUN=false
YES=false
INSTALL_DIR="${METIS_AI_INSTALL_DIR:-}"
SERVICE_NAME="${METIS_AI_SERVICE_NAME:-metis-ai}"

discover_install_dir() {
  local service="$1" wd envfiles envfile
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl cat "${service}.service" >/dev/null 2>&1 || return 1
  wd="$(systemctl show -p WorkingDirectory --value "${service}.service" 2>/dev/null || true)"
  if [[ -n "$wd" && "$wd" != "/" && "$wd" != "$HOME" ]]; then
    printf '%s' "$wd"
    return 0
  fi
  envfiles="$(systemctl show -p EnvironmentFiles --value "${service}.service" 2>/dev/null || true)"
  envfile="$(printf '%s\n' "$envfiles" | awk 'NF { print $1; exit }')"
  if [[ -n "$envfile" && -e "$envfile" ]]; then
    printf '%s' "$(dirname "$envfile")"
    return 0
  fi
  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --service-name) SERVICE_NAME="${2:-}"; shift 2 ;;
    --keep-data) KEEP_DATA=true; shift ;;
    --remove-data) KEEP_DATA=false; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --yes) YES=true; shift ;;
    -h|--help) echo "Usage: uninstall.sh [--install-dir DIR] [--service-name NAME] [--keep-data|--remove-data] [--dry-run] [--yes]"; echo "If --install-dir is omitted, the directory is read from ${SERVICE_NAME}.service (WorkingDirectory / EnvironmentFile)."; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$INSTALL_DIR" ]]; then
  INSTALL_DIR="$(discover_install_dir "$SERVICE_NAME" || true)"
fi
[[ -n "$INSTALL_DIR" ]] || { echo "Could not detect the install directory from ${SERVICE_NAME}.service. Pass --install-dir DIR." >&2; exit 2; }
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"
MANIFEST="$INSTALL_DIR/.metis-ai-install.json"
SERVICE="$SERVICE_NAME"
DATA_DIR=""
INSTALL_METHOD="native"
if [[ -f "$MANIFEST" ]]; then
  command -v python3 >/dev/null 2>&1 || { echo "python3 is required to read the install manifest." >&2; exit 1; }
  IFS=$'\t' read -r SERVICE DATA_DIR INSTALL_METHOD < <(python3 - "$MANIFEST" <<'PY'
import json, sys
data=json.load(open(sys.argv[1]))
print(data.get("serviceName", "metis-ai"), data.get("dataDir", ""), data.get("installMethod", "native"), sep="\t")
PY
  )
else
  envfile="$INSTALL_DIR/.env"
  if [[ -f "$envfile" ]]; then
    DATA_DIR="$(awk -F= '/^CHAT_DATA_DIR=/{sub(/^CHAT_DATA_DIR=/, ""); gsub(/^"|"$/, ""); print; exit}' "$envfile")"
  fi
  [[ -f "$INSTALL_DIR/docker-compose.yml" ]] && INSTALL_METHOD="docker"
fi
[[ "$INSTALL_DIR" != "/" && "$INSTALL_DIR" != "$HOME" ]] || { echo "Refusing to remove unsafe install directory." >&2; exit 1; }
if [[ "$YES" != true ]]; then
  printf 'Remove Metis AI installation at %s? ' "$INSTALL_DIR"
  read -r answer
  [[ "$answer" == "yes" ]] || { echo "Aborted."; exit 0; }
fi
run() { if [[ "$DRY_RUN" == true ]]; then printf '+ %s\n' "$*"; else "$@"; fi; }

KEEP_STASH=""
stash_nested_keep_data() {
  [[ "$KEEP_DATA" == true ]] || return 0
  if [[ -z "$DATA_DIR" && -d "$INSTALL_DIR/data" ]]; then
    DATA_DIR="$INSTALL_DIR/data"
  fi
  [[ -n "$DATA_DIR" && -e "$DATA_DIR" ]] || return 0
  local data_real install_real
  data_real="$(realpath -m "$DATA_DIR")"
  install_real="$(realpath -m "$INSTALL_DIR")"
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
elif command -v systemctl >/dev/null 2>&1; then
  for unit in "$SERVICE.service" "$SERVICE-worker.service" "$SERVICE-mcp.service"; do
    run sudo systemctl disable --now "$unit" >/dev/null 2>&1 || true
    run sudo rm -f "/etc/systemd/system/$unit"
  done
  run sudo systemctl daemon-reload
fi
stash_nested_keep_data
if [[ "$KEEP_DATA" != true && -n "$DATA_DIR" && "$DATA_DIR" != "/" && "$DATA_DIR" != "$INSTALL_DIR" ]]; then
  run rm -rf -- "$DATA_DIR"
fi
if [[ "$KEEP_DATA" != true && "$DATA_DIR" == "$INSTALL_DIR" ]]; then
  echo "Refusing to remove data because it is inside the installation directory; use a separate data directory." >&2
  exit 1
fi
run rm -rf -- "$INSTALL_DIR"
if [[ -n "$KEEP_STASH" ]]; then
  echo "Metis AI uninstalled. Data kept: $KEEP_STASH"
else
  echo "Metis AI uninstalled. Data kept: $KEEP_DATA"
fi
