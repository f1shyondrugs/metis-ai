import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../components/model-options-menu.tsx", import.meta.url), "utf8");

test("mobile chat controls use a small viewport-bounded popover", () => {
  assert.match(source, /max-h-\[min\(54dvh,24rem\)\]/);
  assert.match(source, /w-\[min\(18\.5rem,calc\(100vw-1\.5rem\)\)\]/);
  assert.match(source, /collisionPadding=\{16\}/);
  assert.match(source, /overscroll-contain/);
});

test("mobile permissions use progressive disclosure instead of large cards", () => {
  assert.match(source, /aria-expanded=\{mobilePermissionsOpen\}/);
  assert.match(source, /setMobilePermissionsOpen\(\(open\) => !open\)/);
  assert.match(source, /setMobilePermissionsOpen\(false\)/);
  assert.doesNotMatch(source, /grid grid-cols-2 gap-1\.5/);
});

test("mobile enum model options render as a compact segmented control", () => {
  assert.match(source, /gridTemplateColumns: `repeat\(\$\{Math\.max\(1, param\.values\.length\)\}, minmax\(0, 1fr\)\)`/);
  assert.match(source, /rounded-xl bg-muted\/25 p-1/);
  assert.match(source, />\s*Reset\s*<\/Button>/);
});


test("mobile controls avoid repeating the selected model heading", () => {
  assert.match(source, /hidden items-center justify-between gap-3 md:flex/);
  assert.match(source, />Access<\/span>/);
  assert.match(source, />Model settings<\/span>/);
});
