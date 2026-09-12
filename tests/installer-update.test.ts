import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInstallerUpdatePlan } from "../lib/installer-update";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const base = {
  root,
  serviceName: "metis-ai",
  dataDir: path.join(root, "data"),
};

test("native Linux settings updates run linux.sh non-interactively", () => {
  const plan = buildInstallerUpdatePlan({
    ...base,
    docker: false,
    channel: "releases",
    tag: "v1.0.5",
    platform: "linux",
  });
  assert.equal(plan.kind, "native");
  assert.equal(plan.command, "/bin/bash");
  assert.equal(plan.scriptSource, path.join(root, "install", "linux.sh"));
  assert.deepEqual(plan.args, [
    plan.scriptSource,
    "--non-interactive",
    "--native",
    "--install-dir",
    root,
    "--service-name",
    "metis-ai",
    "--version",
    "v1.0.5",
  ]);
  assert.equal(plan.unitName, "metis-ai-self-update");
});

test("native commit updates omit --version so the installer git-pulls master", () => {
  const plan = buildInstallerUpdatePlan({
    ...base,
    docker: false,
    channel: "commits",
    tag: "v1.0.5",
    platform: "linux",
  });
  assert.equal(plan.args.includes("--version"), false);
});

test("Docker settings updates run docker.sh with the release tag", () => {
  const plan = buildInstallerUpdatePlan({
    ...base,
    docker: true,
    channel: "releases",
    tag: "v1.0.5",
    platform: "linux",
  });
  assert.equal(plan.kind, "docker");
  assert.equal(plan.scriptSource, path.join(root, "public", "install", "docker.sh"));
  assert.deepEqual(plan.args, [
    plan.scriptSource,
    "--non-interactive",
    "--install-dir",
    root,
    "--version",
    "v1.0.5",
  ]);
});

test("macOS and Windows plans use the platform installer files", () => {
  const mac = buildInstallerUpdatePlan({
    ...base,
    docker: false,
    channel: "releases",
    tag: "v1.0.5",
    platform: "darwin",
  });
  assert.equal(mac.scriptSource, path.join(root, "install", "macos.sh"));
  assert.equal(mac.unitName, undefined);

  const win = buildInstallerUpdatePlan({
    ...base,
    docker: false,
    channel: "releases",
    tag: "v1.0.5",
    platform: "win32",
  });
  assert.equal(win.command, "powershell.exe");
  assert.equal(win.scriptSource, path.join(root, "install", "windows.ps1"));
  assert.equal(win.args.includes("-Version"), true);
  assert.equal(win.args.includes("v1.0.5"), true);
});
