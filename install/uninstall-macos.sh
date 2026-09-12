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
if [[ "$KEEP_DATA" != true && -n "$DATA_DIR" && "$DATA_DIR" != "/" && "$DATA_DIR" != "$INSTALL_DIR" ]]; then
  run rm -rf -- "$DATA_DIR"
fi
run rm -rf -- "$INSTALL_DIR"
echo "Metis AI uninstalled. Data kept: $KEEP_DATA"
