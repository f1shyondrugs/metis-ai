import { readFileSync, existsSync } from "node:fs";
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

test("README documents the bootstrap one-liner rather than curling platform scripts into bash", () => {
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /\/bin\/bash -c "\$\(curl -fsSL https:\/\/raw\.githubusercontent\.com\/f1shyondrugs\/metis-ai\/master\/install\.sh\)"/);
  assert.match(readme, /irm https:\/\/raw\.githubusercontent\.com\/f1shyondrugs\/metis-ai\/master\/install\.ps1 \| iex/);
  assert.doesNotMatch(readme, /install\/linux\.sh \| bash/);
  assert.doesNotMatch(readme, /install\/macos\.sh \| bash/);
  assert.doesNotMatch(readme, /install\/windows\.ps1 \| iex/);
});
