import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(os.tmpdir(), "metis-onboard-"));
process.env.CHAT_DATA_DIR = dataDir;
process.env.CHAT_DB_PATH = path.join(dataDir, "chat.sqlite");
process.env.AGENT_CWD = dataDir;
process.env.AI_CHAT_ROOT = dataDir;
process.env.CHAT_PASSWORD = "must-not-become-a-user";
delete process.env.METIS_AI_BOOTSTRAP_PASSWORD;

test("setup API and wizard exist for first-run onboarding", () => {
  const api = readFileSync(path.join(root, "app/api/setup/route.ts"), "utf8");
  const wizard = readFileSync(path.join(root, "components/setup-wizard.tsx"), "utf8");
  const helper = readFileSync(path.join(root, "lib/setup.ts"), "utf8");
  assert.match(api, /action === "bootstrap"/);
  assert.match(api, /markSetupComplete/);
  assert.match(wizard, /Welcome to Metis/);
  assert.match(wizard, /embedded/);
  assert.match(helper, /setup_complete/);
  assert.match(helper, /markSetupIncomplete/);
  assert.match(api, /markSetupIncomplete/);
});

test("onboarding uses the update-screen hands and four real steps", () => {
  const wizard = readFileSync(path.join(root, "components/setup-wizard.tsx"), "utf8");
  const hands = readFileSync(path.join(root, "components/hands-stage.tsx"), "utf8");
  const maintenance = readFileSync(path.join(root, "components/maintenance-screen.tsx"), "utf8");
  assert.match(hands, /hand-left\.png/);
  assert.match(hands, /hand-right\.png/);
  assert.match(wizard, /HandsStage/);
  assert.match(maintenance, /HandsStage/);
  assert.match(wizard, /"welcome"/);
  assert.match(wizard, /"people"/);
  assert.match(wizard, /"provider"/);
  assert.match(wizard, /"ready"/);
  assert.match(wizard, /Admin/);
  assert.match(wizard, /\/api\/admin\/users/);
  assert.match(wizard, /isAdmin: makeAdmin/);
});

test("status API exposes setup so first-run can skip Sign-In", () => {
  const status = readFileSync(path.join(root, "app/api/status/route.ts"), "utf8");
  const shell = readFileSync(path.join(root, "components/app-shell.tsx"), "utf8");
  assert.match(status, /getSetupStatus/);
  assert.match(status, /setup: getSetupStatus/);
  assert.match(shell, /data\.setup/);
  const emptyUsersAt = shell.indexOf("setupStatus?.needed && !setupStatus.hasUsers");
  const signInAt = shell.indexOf(">Sign in<");
  assert.ok(emptyUsersAt >= 0 && signInAt > emptyUsersAt, "empty-user onboarding must render before Sign in");
});

test("existing installs with users are not forced through first-run without a session", () => {
  const helper = readFileSync(path.join(root, "lib/setup.ts"), "utf8");
  const shell = readFileSync(path.join(root, "components/app-shell.tsx"), "utf8");
  assert.match(helper, /return userCount\(\) > 0/);
  assert.match(shell, /setupStatus\.needed && authed/);
});

test("CHAT_PASSWORD does not seed a first-run user", async () => {
  const helper = readFileSync(path.join(root, "lib/sqlite.ts"), "utf8");
  assert.doesNotMatch(helper, /users\.push\(\{/);
  assert.doesNotMatch(helper, /hashPassword\(process\.env\.CHAT_PASSWORD/);
  const linux = readFileSync(path.join(root, "install/linux.sh"), "utf8");
  assert.doesNotMatch(linux, /CHAT_PASSWORD/);
  const { getDatabase } = await import("../lib/sqlite");
  const { getSetupStatus } = await import("../lib/setup");
  const count = Number((getDatabase().prepare("SELECT COUNT(*) as count FROM users").get() as { count: number }).count);
  assert.equal(count, 0);
  const status = getSetupStatus();
  assert.equal(status.hasUsers, false);
  assert.equal(status.needed, true);
});
