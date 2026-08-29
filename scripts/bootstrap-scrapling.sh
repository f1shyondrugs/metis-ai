#!/usr/bin/env bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
python3 -m venv .venv-scrapling
.venv-scrapling/bin/pip install --upgrade pip
.venv-scrapling/bin/pip install 'scrapling[fetchers]==0.4.15'
echo "Scrapling static fetcher ready at $ROOT/.venv-scrapling"
