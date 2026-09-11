#!/usr/bin/env bash
# Metis AI one-line installer bootstrap.
#
# This file is the documented one-liner target. It never runs the real
# installer from a pipe. It downloads the platform script to a temp file,
# then execs that file so prompts, arguments and `set -e` behave like a
# normal command.
#
# Interactive (stdin stays on the terminal):
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/f1shyondrugs/metis-ai/master/install.sh)"
#
# Piped (still safe: the body is a function, so Bash parses the whole file
# before doing any work, then re-execs from a real file):
#   curl -fsSL https://raw.githubusercontent.com/f1shyondrugs/metis-ai/master/install.sh | bash
#
# Arguments:
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/f1shyondrugs/metis-ai/master/install.sh)" -- --non-interactive --port 3100

set -euo pipefail

metis_install() {
  local base script tmp
  base="${METIS_AI_INSTALL_BASE:-https://raw.githubusercontent.com/f1shyondrugs/metis-ai/master}"
  base="${base%/}"
  # v1.0.0 platform scripts cannot compile node-pty on minimal Ubuntu (no make).
  # Native one-liners pin INSTALL_BASE to that tag; fetch current scripts instead.
  if [[ "$base" == "https://raw.githubusercontent.com/f1shyondrugs/metis-ai/v1.0.0" ]]; then
    base="https://raw.githubusercontent.com/f1shyondrugs/metis-ai/master"
  fi
  case "$(uname -s)" in
    Darwin) script="install/macos.sh" ;;
    Linux) script="install/linux.sh" ;;
    *)
      printf 'Error: unsupported OS %s. On Windows run: irm %s/install.ps1 | iex\n' "$(uname -s)" "$base" >&2
      return 1
      ;;
  esac
  if ! command -v curl >/dev/null 2>&1; then
    printf 'Error: curl is required to download the Metis AI installer.\n' >&2
    return 1
  fi
  tmp="$(mktemp "${TMPDIR:-/tmp}/metis-ai-install.XXXXXX")"
  if ! curl -fsSL "$base/$script" -o "$tmp"; then
    rm -f "$tmp"
    printf 'Error: failed to download %s/%s\n' "$base" "$script" >&2
    return 1
  fi
  if ! grep -q 'Metis AI' "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    printf 'Error: downloaded installer looks invalid: %s/%s\n' "$base" "$script" >&2
    return 1
  fi
  chmod u+x "$tmp"
  exec /bin/bash "$tmp" "$@"
}

metis_install "$@"
