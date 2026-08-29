import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");
const toolGroup = readFileSync(new URL("../components/tool-call-chip.tsx", import.meta.url), "utf8");

test("the trailing tool group defaults open until later answer content appears", () => {
  assert.match(shell, /autoExpand=\{bi === lastBlockIndex\}/);
  assert.match(toolGroup, /const groupOpen = userOpen \?\? Boolean\(live \|\| autoExpand\)/);
});

test("auto-expanded tool activity can still be manually collapsed", () => {
  assert.match(toolGroup, /useState<boolean \| null>\(null\)/);
  assert.match(toolGroup, /open === null \? !groupOpen : !open/);
  assert.match(toolGroup, /locked=\{false\}/);
});
