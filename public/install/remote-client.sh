#!/usr/bin/env bash
set -Eeuo pipefail

server=""
token=""
permission_mode="user"
install_dir="${METIS_REMOTE_CLIENT_DIR:-$HOME/.metis-ai/remote-client}"
node_version="${METIS_NODE_VERSION:-22.16.0}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) server="${2:-}"; shift 2 ;;
    --enrollment-token) token="${2:-}"; shift 2 ;;
    --permission-mode) permission_mode="${2:-user}"; shift 2 ;;
    --install-dir) install_dir="${2:-}"; shift 2 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ "$permission_mode" == "user" || "$permission_mode" == "admin" ]] || { printf "Invalid permission mode\n" >&2; exit 2; }
[[ -n "$server" && -n "$token" ]] || { printf '%s\n' '--server and --enrollment-token are required' >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { printf '%s\n' 'curl is required' >&2; exit 1; }
mkdir -p "$install_dir"
version_at_least_20() {
  command -v "$1" >/dev/null 2>&1 &&
    [[ "$("$1" -p 'process.versions.node.split(".")[0]')" -ge 20 ]]
}
if ! version_at_least_20 node; then
  read -r -p "Node.js 20 or newer is missing or too old. Install it automatically? [Y/n] " answer < /dev/tty
  [[ -z "$answer" || "$answer" =~ ^([Yy][Ee][Ss]|[Yy])$ ]] ||
    { printf '%s\n' 'Node.js 20 or newer is required' >&2; exit 1; }
  case "$(uname -m)" in
    x86_64|amd64) node_arch=x64 ;;
    aarch64|arm64) node_arch=arm64 ;;
    armv7l) node_arch=armv7l ;;
    *) printf 'Unsupported Linux architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
  esac
  runtime_dir="$install_dir/.runtime"
  mkdir -p "$runtime_dir"
  archive="$runtime_dir/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-${node_arch}.tar.xz" -o "$archive"
  tar -xJf "$archive" -C "$runtime_dir"
  rm -rf "$runtime_dir/node"
  mv "$runtime_dir/node-v${node_version}-linux-${node_arch}" "$runtime_dir/node"
  rm -f "$archive"
  export PATH="$runtime_dir/node/bin:$PATH"
fi
version_at_least_20 node || { printf '%s\n' 'Node.js 20 or newer is required after installation' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { printf '%s\n' 'npm is required. Install Node.js 20 or newer and run this again.' >&2; exit 1; }
base_url="${server%/}"
response="$(curl -fsSL -X POST "$base_url/api/remote-clients/enroll" \
  -H 'Content-Type: application/json' \
  --data "$(node -e 'console.log(JSON.stringify({token:process.argv[1],name:require("node:os").hostname(),os:process.platform,architecture:process.arch,version:"1.0.0",hostname:require("node:os").hostname(),permissionMode:process.argv[2],capabilities:process.argv[2]==="admin"?["user_files","user_processes","user_directories","system_files","services","disks","admin_processes"]:["user_files","user_processes","user_directories"]}))' "$token" "$permission_mode")")"
node -e 'const value=JSON.parse(process.argv[1]); if (!value.client?.id || !value.credential) process.exit(1)' "$response" ||
  { printf '%s\n' 'Enrollment failed' >&2; exit 1; }
node -e 'const fs=require("node:fs"),path=require("node:path"),value=JSON.parse(process.argv[1]),file=process.argv[2]; fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,JSON.stringify({server:process.argv[3],permissionMode:process.argv[4],clientId:value.client.id,credential:value.credential},null,2)+"\n",{mode:0o600}); fs.chmodSync(file,0o600)' \
  "$response" "$install_dir/config.json" "$base_url" "$permission_mode"
curl -fsSL "$base_url/install/remote-client.mjs" -o "$install_dir/client.mjs"
curl -fsSL "$base_url/install/remote-client-uninstall.sh" -o "$install_dir/uninstall.sh"
chmod 700 "$install_dir/client.mjs"
chmod 700 "$install_dir/uninstall.sh"
(cd "$install_dir" && npm init -y >/dev/null 2>&1 && npm install --omit=dev --no-audit --no-fund ws >/dev/null)

if command -v systemctl >/dev/null 2>&1; then
  service_name="metis-ai-remote-client"
  sudo tee "/etc/systemd/system/$service_name.service" >/dev/null <<EOF
[Unit]
Description=Metis AI remote client
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=$USER
WorkingDirectory=$install_dir
ExecStart=$(command -v node) $install_dir/client.mjs --config $install_dir/config.json
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$service_name.service"
else
  nohup node "$install_dir/client.mjs" --config "$install_dir/config.json" >/dev/null 2>&1 &
fi
printf 'Remote client enrolled successfully (%s mode): %s\n' "$permission_mode" "$install_dir"
printf 'Remove with: %s/uninstall.sh\n' "$install_dir"

