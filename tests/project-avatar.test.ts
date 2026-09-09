import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const avatarSource = readFileSync(new URL("../components/project-avatar.tsx", import.meta.url), "utf8");
const shellSource = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");

test("logo avatars expose a non-empty alt when a label is passed", () => {
  assert.match(avatarSource, /label\?: string/);
  assert.match(avatarSource, /const accessibleName = label\?\.trim\(\) \|\| ""/);
  assert.match(avatarSource, /alt=\{accessibleName\}/);
  assert.doesNotMatch(avatarSource, /alt=""/);
});

test("glyph avatars become named images instead of hidden decoration", () => {
  assert.match(avatarSource, /role: "img" as const, "aria-label": accessibleName/);
  assert.match(avatarSource, /"aria-hidden": true/);
  assert.match(avatarSource, /<Icon className=\{className\} aria-hidden="true" \/>/);
});

test("chat rows pass the project name into the avatar", () => {
  const row = shellSource.slice(shellSource.indexOf("renderChat={(chat) => {"));
  assert.match(row, /label=\{project\.name\}/);
});
