import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installerDir = path.join(root, "public", "install");

test("all platform installers and uninstallers are published", () => {
  for (const file of [
    "linux.sh",
    "macos.sh",
    "windows.ps1",
    "uninstall.sh",
    "uninstall-macos.sh",
    "uninstall.ps1",
    "manifest.json",
    "install.sh",
    "install.ps1",
  ]) {
    assert.equal(existsSync(path.join(installerDir, file)), true, file);
  }
  assert.equal(existsSync(path.join(root, "install.sh")), true, "root install.sh");
  assert.equal(existsSync(path.join(root, "install.ps1")), true, "root install.ps1");
});

test("published installers match the install/ sources", () => {
  for (const file of ["linux.sh", "macos.sh", "windows.ps1", "uninstall.sh", "uninstall-macos.sh", "uninstall.ps1"]) {
    const source = readFileSync(path.join(root, "install", file), "utf8");
    const published = readFileSync(path.join(installerDir, file), "utf8");
    assert.equal(published, source, file);
  }
  assert.equal(readFileSync(path.join(installerDir, "install.sh"), "utf8"), readFileSync(path.join(root, "install.sh"), "utf8"));
  assert.equal(readFileSync(path.join(installerDir, "install.ps1"), "utf8"), readFileSync(path.join(root, "install.ps1"), "utf8"));
});

test("installer sources do not contain this deployment's machine path", () => {
  const files = [
    "install.sh",
    "install.ps1",
    path.join("install", "linux.sh"),
    path.join("install", "macos.sh"),
    path.join("install", "windows.ps1"),
    path.join("install", "uninstall.sh"),
    path.join("install", "uninstall-macos.sh"),
    path.join("install", "uninstall.ps1"),
  ];
  const localPath = ["/home", "f1shy312"].join("/");
  const localDomain = ["metis-ai", "f1shy312.com"].join(".");
  for (const file of files) {
    const content = readFileSync(path.join(root, file), "utf8");
    assert.equal(content.includes(localPath), false, file);
    assert.equal(content.includes(localDomain), false, file);
  }
});

test("installers default to Docker and keep a native fallback", () => {
  for (const file of ["linux.sh", "macos.sh"]) {
    const content = readFileSync(path.join(root, "install", file), "utf8");
    const publicContent = readFileSync(path.join(installerDir, file), "utf8");
    for (const source of [content, publicContent]) {
      assert.match(source, /--native/);
      assert.match(source, /docker compose/);
    }
  }
  const windows = readFileSync(path.join(root, "install", "windows.ps1"), "utf8");
  assert.match(windows, /-Native/);
  assert.match(windows, /docker compose/);
  assert.equal(existsSync(path.join(root, "Dockerfile")), true);
  assert.equal(existsSync(path.join(root, "docker-compose.yml")), true);
  assert.equal(existsSync(path.join(root, "docker", "entrypoint.sh")), true);
});

test("all platform installers expose an explicit network-host option", () => {
  for (const file of ["linux.sh", "macos.sh", "windows.ps1"]) {
    const content = readFileSync(path.join(root, "install", file), "utf8");
    const publicContent = readFileSync(path.join(installerDir, file), "utf8");
    for (const source of [content, publicContent]) {
      assert.match(source, /AI_CHAT_HOST/);
      assert.match(source, /AI_CHAT_WORKER_CONCURRENCY[^\n]*25/);
      assert.match(source, /0\.0\.0\.0/);
    }
  }
});

test("linux native installer installs C/C++ build tools before pnpm install", () => {
  const content = readFileSync(path.join(root, "install", "linux.sh"), "utf8");
  const published = readFileSync(path.join(installerDir, "linux.sh"), "utf8");
  for (const source of [content, published]) {
    assert.match(source, /ensure_native_build_tools/);
    assert.match(source, /build-essential/);
    const toolsAt = source.indexOf("ensure_native_build_tools\n(");
    const pnpmAt = source.indexOf("pnpm install --frozen-lockfile");
    assert.ok(toolsAt >= 0 && pnpmAt > toolsAt, "build tools must be ensured before pnpm install");
  }
});

test("unix bootstrap remaps the v1.0.0 install base to current master scripts", () => {
  const bootstrap = readFileSync(path.join(root, "install.sh"), "utf8");
  const published = readFileSync(path.join(installerDir, "install.sh"), "utf8");
  for (const source of [bootstrap, published]) {
    assert.match(source, /raw\.githubusercontent\.com\/f1shyondrugs\/metis-ai\/v1\.0\.0/);
    assert.match(source, /base="https:\/\/raw\.githubusercontent\.com\/f1shyondrugs\/metis-ai\/master"/);
  }
});

test("unix bootstrap downloads a file then execs it instead of running from a pipe", () => {
  const bootstrap = readFileSync(path.join(root, "install.sh"), "utf8");
  assert.match(bootstrap, /metis_install\(\)/);
  assert.match(bootstrap, /mktemp/);
  assert.match(bootstrap, /exec \/bin\/bash "\$tmp"/);
  assert.match(bootstrap, /\/bin\/bash -c "\$\(curl/);
  assert.doesNotMatch(bootstrap, /\| bash -s/);
});

test("windows bootstrap has no param\(\) so irm \| iex is valid", () => {
  const bootstrap = readFileSync(path.join(root, "install.ps1"), "utf8");
  assert.equal(/^\s*param\s*\(/m.test(bootstrap), false);
  assert.match(bootstrap, /Invoke-WebRequest/);
  assert.match(bootstrap, /-File \$dest/);
  const windows = readFileSync(path.join(root, "install", "windows.ps1"), "utf8");
  assert.match(windows, /^\s*param\s*\(/m);
  assert.match(windows, /must be invoked with powershell -File/);
});

test("remote Windows client installer verifies Node safely and waits for authentication", () => {
  const installer = readFileSync(path.join(installerDir, "remote-client.ps1"), "utf8");
  const client = readFileSync(path.join(installerDir, "remote-client.mjs"), "utf8");
  assert.match(installer, /parseInt\(process\.versions\.node, 10\)/);
  assert.doesNotMatch(installer, /process\.versions\.node\.split\(\.\)/);
  assert.match(installer, /did not confirm a connection/);
  assert.match(installer, /\bauthenticated\b/);
  assert.match(client, /message\.type === "authenticated"/);
  assert.match(client, /log\("authenticated"/);
});

test("platform installers collect configuration before side effects and support dry-run", () => {
  for (const file of ["linux.sh", "macos.sh"]) {
    const content = readFileSync(path.join(root, "install", file), "utf8");
    assert.doesNotMatch(content, /Initial (username|login)|Initial password|ask_secret|password-file/);
    assert.match(content, /--dry-run/);
    assert.match(content, /run-service\.sh/);
 assert.match(content, /first-run UI|without account prompts|Install Metis AI without account prompts/);
    const dryRunAt = content.indexOf("if (( dry_run ))");
    const cloneAt = content.indexOf("git clone");
    assert.ok(dryRunAt >= 0 && cloneAt > dryRunAt, `${file} must dry-run before clone`);
  }
  const windows = readFileSync(path.join(root, "install", "windows.ps1"), "utf8");
  assert.match(windows, /\$DryRun/);
  assert.match(windows, /run-service\.ps1/);
});

test("installers detect an existing Metis install from OS services", () => {
  const linux = readFileSync(path.join(root, "install", "linux.sh"), "utf8");
  const macos = readFileSync(path.join(root, "install", "macos.sh"), "utf8");
  const windows = readFileSync(path.join(root, "install", "windows.ps1"), "utf8");
  const docker = readFileSync(path.join(root, "public", "install", "docker.sh"), "utf8");
  assert.match(linux, /systemctl cat "\$\{service_name\}\.service"/);
  assert.match(linux, /Choice \[u\/r\/n\/a\]/);
  assert.match(linux, /--replace-existing/);
  assert.match(linux, /already installed as \$\{service_name\}\.service/);
  assert.match(macos, /LaunchAgents\/\$\{service_name\}-app\.plist/);
  assert.match(macos, /Choice \[u\/r\/n\/a\]/);
  assert.match(windows, /CurrentVersion\\Run/);
  assert.match(windows, /Choice \[u\/r\/n\/a\]/);
  assert.match(docker, /systemctl cat metis-ai\.service/);
  assert.match(docker, /--replace-existing/);
  assert.doesNotMatch(linux, /if \[\[ -f "\$dir\/uninstall\.sh" \]\]/);
  assert.doesNotMatch(linux, /bash "\$uninstaller" --install-dir/);
  assert.match(linux, /metis-keep-data/);
  assert.match(linux, /stash_nested_data/);
  assert.match(linux, /stop_linux_units/);
  assert.doesNotMatch(macos, /if \[\[ -f "\$dir\/uninstall-macos\.sh" \]\]/);
  assert.match(macos, /metis-keep-data/);
  assert.match(windows, /Uninstall-DetectedInstall/);
  assert.match(windows, /metis-keep-data/);
  assert.doesNotMatch(docker, /existing_native_dir:-\}\/uninstall\.sh/);
  assert.match(docker, /Stopping native Metis AI/);
  const uninstall = readFileSync(path.join(root, "install", "uninstall.sh"), "utf8");
  assert.match(uninstall, /discover_install_dir/);
  assert.match(uninstall, /WorkingDirectory/);
  assert.match(uninstall, /stash_nested_keep_data/);
  assert.match(uninstall, /metis-keep-data/);
  assert.doesNotMatch(uninstall, /--install-dir is required/);
  const detectAt = linux.indexOf("systemctl cat");
  const cloneAt = linux.indexOf("git clone");
  assert.ok(detectAt >= 0 && cloneAt > detectAt, "linux service detection must run before clone");
});

test("windows installer installs pnpm into the install directory instead of Program Files", () => {
  const windows = readFileSync(path.join(root, "install", "windows.ps1"), "utf8");
  assert.match(windows, /Get-PnpmCommand/);
  assert.match(windows, /--prefix \$runtimePrefix pnpm@9 \| Out-Null/);
  assert.doesNotMatch(windows, /corepack prepare pnpm/);
});

test("windows services start with an absolute node path and short cmd wrappers", () => {
  const windows = readFileSync(path.join(root, "install", "windows.ps1"), "utf8");
  const uninstall = readFileSync(path.join(root, "install", "uninstall.ps1"), "utf8");
  assert.match(windows, /METIS_NODE_BIN=/);
  assert.match(windows, /\$env:METIS_NODE_BIN/);
  assert.match(windows, /run-\$suffix\.cmd/);
  assert.match(windows, /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run/);
  assert.match(windows, /Start-Process/);
  assert.match(windows, /for \(\$attempt = 0; \$attempt -lt 45;/);
  assert.doesNotMatch(windows, /throw "Failed to create scheduled task/);
  assert.match(uninstall, /Remove-ItemProperty/);
  assert.match(uninstall, /Stop-Process/);
  assert.match(uninstall, /cmd\.exe \/c "schtasks \/Delete/);
  assert.match(uninstall, /function Remove-Tree/);
});

test("installers merge a previous .env on replace and upgrade", () => {
  const linux = readFileSync(path.join(root, "install", "linux.sh"), "utf8");
  const macos = readFileSync(path.join(root, "install", "macos.sh"), "utf8");
  const windows = readFileSync(path.join(root, "install", "windows.ps1"), "utf8");
  const uninstall = readFileSync(path.join(root, "install", "uninstall.sh"), "utf8");
  const uninstallMac = readFileSync(path.join(root, "install", "uninstall-macos.sh"), "utf8");
  const uninstallWin = readFileSync(path.join(root, "install", "uninstall.ps1"), "utf8");
  const docker = readFileSync(path.join(root, "public", "install", "docker.sh"), "utf8");
  for (const source of [linux, macos]) {
    assert.match(source, /preserve_existing_env/);
    assert.match(source, /merge_preserved_env/);
    assert.match(source, /metis-keep-env/);
    assert.match(source, /old values kept, new keys added/);
    const preserveAt = source.indexOf('preserve_existing_env "$dir"');
    const rmAt = source.indexOf('rm -rf -- "$dir"');
    assert.ok(preserveAt >= 0 && rmAt > preserveAt, "env must be copied before the install directory is removed");
    const writeAt = source.indexOf('} > "$install_dir/.env"');
    const mergeAt = source.lastIndexOf('merge_preserved_env "$install_dir/.env"');
    assert.ok(writeAt >= 0 && mergeAt > writeAt, "merge must run after writing the new .env template");
    const applyAt = source.lastIndexOf('apply_merged_runtime_ports "$install_dir/.env"');
    assert.ok(applyAt > mergeAt, "health-check ports must be re-read after env merge");
    const pickAt = source.lastIndexOf('mcp_port="$(pick_free_port "$mcp_port")"');
    const stopAt = source.indexOf("uninstall_detected_install");
    assert.ok(pickAt > stopAt, "MCP port must be chosen after stopping a replaced install");
  }
  assert.match(windows, /Save-ExistingEnv/);
  assert.match(windows, /Merge-PreservedEnv/);
  assert.match(windows, /metis-keep-env/);
  assert.match(uninstall, /stash_keep_env/);
  assert.match(uninstall, /metis-keep-env/);
  assert.match(uninstallMac, /stash_keep_env/);
  assert.match(uninstallWin, /metis-keep-env/);
  assert.match(docker, /if \[\[ ! -f "\$ENV_FILE" \]\]/);

  const awkFrom = (source: string) => {
    const begin = source.indexOf("# METIS_ENV_MERGE_BEGIN");
    const end = source.indexOf("# METIS_ENV_MERGE_END");
    assert.ok(begin >= 0 && end > begin, "env merge awk markers");
    const block = source.slice(begin, end);
    const match = block.match(/awk -v preserved="\$preserved" '([\s\S]*)' "\$dest"/);
    assert.ok(match, "env merge awk program");
    return match[1];
  };
  const awkProgram = awkFrom(linux);
  assert.equal(awkFrom(macos), awkProgram);

  const dir = mkdtempSync(path.join(os.tmpdir(), "metis-env-merge-"));
  try {
    const oldPath = path.join(dir, "old.env");
    const newPath = path.join(dir, "new.env");
    writeFileSync(
      oldPath,
      [
        'AI_CHAT_SECRETS_KEY="oldsecret"',
        'MCP_BEARER_TOKEN="oldtoken"',
        'CUSTOM_KEY="keepme"',
        'CHAT_DATA_DIR="/old/data"',
        'PORT="3200"',
        "",
      ].join("\n"),
    );
    writeFileSync(
      newPath,
      [
        'AI_CHAT_SECRETS_KEY="newsecret"',
        'MCP_BEARER_TOKEN="newtoken"',
        'CHAT_DATA_DIR="/new/data"',
        'PORT="3100"',
        'NEW_KEY="added"',
        'AI_CHAT_ROOT="/new/root"',
        "",
      ].join("\n"),
    );
    const merged = execFileSync("awk", ["-v", `preserved=${oldPath}`, awkProgram, newPath], { encoding: "utf8" });
    assert.match(merged, /AI_CHAT_SECRETS_KEY="oldsecret"/);
    assert.match(merged, /MCP_BEARER_TOKEN="oldtoken"/);
    assert.match(merged, /CUSTOM_KEY="keepme"/);
    assert.match(merged, /CHAT_DATA_DIR="\/new\/data"/);
    assert.match(merged, /PORT="3200"/);
    assert.match(merged, /NEW_KEY="added"/);
    assert.match(merged, /AI_CHAT_ROOT="\/new\/root"/);
    assert.doesNotMatch(merged, /newsecret/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("README documents the bootstrap one-liner rather than curling platform scripts into bash", () => {
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /\/bin\/bash -c "\$\(curl -fsSL https:\/\/raw\.githubusercontent\.com\/f1shyondrugs\/metis-ai\/master\/install\.sh\)"/);
  assert.match(readme, /irm https:\/\/raw\.githubusercontent\.com\/f1shyondrugs\/metis-ai\/master\/install\.ps1 \| iex/);
  assert.doesNotMatch(readme, /install\/linux\.sh \| bash/);
  assert.doesNotMatch(readme, /install\/macos\.sh \| bash/);
  assert.doesNotMatch(readme, /install\/windows\.ps1 \| iex/);
});

test("unix bootstrap routes uninstall to the platform uninstaller", () => {
  const bootstrap = readFileSync(path.join(root, "install.sh"), "utf8");
  const published = readFileSync(path.join(installerDir, "install.sh"), "utf8");
  for (const source of [bootstrap, published]) {
    assert.match(source, /uninstall --yes --keep-data/);
    assert.match(source, /\[\[ "\$\{1:-\}" == "uninstall" \]\]/);
    assert.match(source, /install\/macos\.sh "\$@"/);
    assert.match(source, /install\/linux\.sh "\$@"/);
  }
  const windows = readFileSync(path.join(root, "install.ps1"), "utf8");
  assert.match(windows, /ToLowerInvariant\(\) -eq "uninstall"/);
  assert.match(windows, /install\/windows\.ps1/);
});

test("uninstall is refused when Metis is not installed", () => {
  const linux = readFileSync(path.join(root, "install", "linux.sh"), "utf8");
  const macos = readFileSync(path.join(root, "install", "macos.sh"), "utf8");
  const uninstall = readFileSync(path.join(root, "install", "uninstall.sh"), "utf8");
  assert.match(linux, /Nothing to uninstall/);
  assert.match(linux, /\[n\] Uninstall and exit/);
  assert.match(macos, /Nothing to uninstall/);
  assert.match(macos, /\[n\] Uninstall and exit/);
  assert.match(uninstall, /Metis AI is not installed as \$\{SERVICE_NAME\}\.service/);
});

test("platform installers accept uninstall and pin a release with --version", () => {
  const linux = readFileSync(path.join(root, "install", "linux.sh"), "utf8");
  const macos = readFileSync(path.join(root, "install", "macos.sh"), "utf8");
  const windows = readFileSync(path.join(root, "install", "windows.ps1"), "utf8");
  for (const source of [linux, macos]) {
    assert.match(source, /linux\.sh uninstall|macos\.sh uninstall/);
    assert.match(source, /\[\[ "\$\{1:-\}" == "uninstall" \]\]/);
    assert.match(source, /--version\) \[\[ \$# -ge 2 \]\]/);
    assert.match(source, /git -C "\$install_dir" checkout --force "\$release_version"/);
  }
  assert.match(linux, /sudo systemctl enable "\$\{service_name\}\.service"/);
  assert.match(linux, /sudo systemctl restart "\$\{service_name\}\.service"/);
  const enableAt = linux.indexOf("sudo systemctl enable \"${service_name}.service\"");
  const restartAt = linux.indexOf("sudo systemctl restart \"${service_name}.service\"");
  assert.ok(enableAt >= 0 && restartAt > enableAt, "linux must restart units after enable so upgrades load the new build");
  assert.match(windows, /\$Command -eq "uninstall"/);
  assert.match(windows, /\[string\]\$Version/);
  assert.match(windows, /git -C \$InstallDir checkout --force \$Version/);
});
