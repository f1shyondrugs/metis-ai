#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "${AI_CHAT_ROOT:-$PROJECT_ROOT}"

BUILD_DIR="${1:-${NEXT_DIST_DIR:-.next-a}}"
case "$BUILD_DIR" in
  .next-a|.next-b) ;;
  *) echo "Refusing unsupported production build directory: $BUILD_DIR" >&2; exit 2 ;;
esac

command -v pnpm >/dev/null 2>&1 || {
  echo "pnpm is not available on PATH" >&2
  exit 127
}

# Next adds custom distDir type paths to tsconfig.json during builds. Keep those
# generated paths out of the source tree so the inactive slot can never make a
# later typecheck fail with stale generated route types.
tsconfig_backup="$(mktemp)"
cp tsconfig.json "$tsconfig_backup"
restore_tsconfig() {
  cp "$tsconfig_backup" tsconfig.json
  rm -f "$tsconfig_backup"
}
trap restore_tsconfig EXIT INT TERM

# Keep webpack/SWC cache between inactive-slot rebuilds. Deleting the whole
# slot forced every deploy to recompile and reminify the entire 10k-line UI.
rollback_dir="${BUILD_DIR}.rollback"
rm -rf -- "$rollback_dir"
if [[ -d "$BUILD_DIR" ]]; then
  mv -- "$BUILD_DIR" "$rollback_dir"
fi
mkdir -p "$BUILD_DIR"
if [[ -d "$rollback_dir/cache" ]]; then
  mv -- "$rollback_dir/cache" "$BUILD_DIR/cache"
fi
restore_build_slot() {
  if [[ ! -s "$BUILD_DIR/BUILD_ID" && -d "$rollback_dir" ]]; then
    rm -rf -- "$BUILD_DIR"
    mv -- "$rollback_dir" "$BUILD_DIR"
  fi
  rm -rf -- "$rollback_dir"
}
trap 'restore_build_slot; restore_tsconfig' EXIT INT TERM
export NEXT_DIST_DIR="$BUILD_DIR"
export NODE_ENV=production
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
# Normal optimized production build. Tailwind source detection is explicitly
# bounded in app/globals.css, which avoids scanning runtime/workspace trees.
pnpm build

[[ -s "$BUILD_DIR/BUILD_ID" ]] || {
  echo "Build completed without $BUILD_DIR/BUILD_ID" >&2
  exit 1
}

rm -rf -- "$rollback_dir"
restore_tsconfig
trap - EXIT INT TERM
