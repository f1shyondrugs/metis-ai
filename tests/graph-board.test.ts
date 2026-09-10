import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const board = readFileSync(new URL("../components/graph-board.tsx", import.meta.url), "utf8");

test("graph void pans and zooms without remounting JSXGraph on slider edits", () => {
  assert.match(board, /structureKey\(spec\)/);
  assert.doesNotMatch(board, /\}, \[boardId, spec\]\);/);
  assert.match(board, /pan: \{ enabled: false \}/);
  assert.match(board, /zoom: \{ enabled: false, wheel: false, pinch: false \}/);
  assert.match(board, /panGraphWindow/);
  assert.match(board, /zoomGraphWindow/);
  assert.match(board, /radial-gradient\(circle at 1px 1px/);
});

test("graph sliders are HTML controls and hover shows a function tooltip", () => {
  assert.match(board, /data-graph-sliders/);
  assert.match(board, /type="range"/);
  assert.match(board, /aria-label=\{`Slider \$\{slider\.name\}`\}/);
  assert.match(board, /data-graph-hover/);
  assert.match(board, /hoverFunction/);
  assert.match(board, /replaceCurve/);
});

test("legend toggles curves, hover dims others, board fills the void", () => {
  assert.match(board, /data-graph-legend/);
  assert.match(board, /toggleFunction/);
  assert.match(board, /aria-pressed/);
  assert.match(board, /paintSelection/);
  assert.match(board, /strokeOpacity/);
  assert.match(board, /fitBoard\(/);
  assert.match(board, /clampGraphHeight\(/);
  assert.match(board, /data-graph-resize/);
  assert.match(board, /Resize graph height/);
  assert.match(board, /cursor-ns-resize/);
  assert.match(board, /height: tall \? undefined : voidHeight/);
  assert.match(board, /measureBoardBox\(/);
  assert.match(board, /getBoundingClientRect\(\)/);
  assert.match(board, /surface\.clientWidth/);
  assert.match(board, /resize\.observe\(surface\)/);
  assert.match(board, /visualViewport/);
  assert.match(board, /data-editor-control=graph/);
  assert.match(board, /from-background to-transparent/);
  assert.match(board, /insertTicks: true/);
  assert.match(board, /create\("axis"/);
  assert.match(board, /\["board", "edit", "code"\]/);
  assert.match(board, /data-graph-edit/);
  assert.doesNotMatch(board, /Title\s*<input/);
  assert.match(board, /createPortal\(overlay/);
  assert.doesNotMatch(board, /\{card\}\s*\n\s*\{typeof window/);
});
