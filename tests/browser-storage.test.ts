import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("browser storage reports numeric sizes and origin details", () => {
  const source = readFileSync(path.join(root, "lib", "server-browser.ts"), "utf8");
  assert.match(source, /sizeBytes: number/);
  assert.match(source, /cookies: BrowserStorageCookie\[\]/);
  assert.match(source, /navigator\.storage\?\.estimate/);
  assert.doesNotMatch(source, /sizeBytes: null/);
});

test("browser storage API exposes POST creation", () => {
  const source = readFileSync(path.join(root, "app", "api", "browser", "storage", "route.ts"), "utf8");
  assert.match(source, /export async function POST\(req: Request\)/);
  assert.match(source, /createBrowserStorageEntry\(/);
  assert.match(source, /localStorage|sessionStorage/);
});

test("settings storage inspector expands an origin before showing values", () => {
  const panel = readFileSync(path.join(root, "components", "settings-panel.tsx"), "utf8");
  assert.match(panel, /expandedBrowserOrigin === item\.origin/);
  assert.match(panel, /setExpandedBrowserOrigin/);
  assert.match(panel, /item\.sizeBytes\.toLocaleString\(\)/);
  assert.match(panel, /Add entry/);
  assert.match(panel, /aria-label=\"Storage entry value\"/);
});
