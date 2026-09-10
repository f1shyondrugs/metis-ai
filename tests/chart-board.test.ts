import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const board = readFileSync(new URL("../components/chart-board.tsx", import.meta.url), "utf8");

test("chart board preserves the editor control contract", () => {
  assert.match(board, /data-chart-source=\{source\}/);
  assert.match(board, /data-editor-control="chart"/);
  assert.match(board, /contentEditable=\{false\}/);
  assert.match(board, /stopPropagation\(\)/);
  assert.match(board, /insertReplacementText/);
  assert.match(board, /closest\("\.editable-markdown"\)/);
});

test("chart board supports board, edit, and code modes", () => {
  assert.match(board, /\["board", "edit", "code"\]/);
  assert.match(board, /data-chart-edit/);
  assert.match(board, /textarea/);
  assert.match(board, />Apply</);
  assert.match(board, /type="color"/);
  assert.match(board, /values \|\| \[\]\)\.join\("/);
  assert.doesNotMatch(board, /Title\s*<input/);
});

test("chart board renders Recharts and supports fullscreen and resize", () => {
  assert.match(board, /ResponsiveContainer/);
  assert.match(board, /BarChart/);
  assert.match(board, /LineChart/);
  assert.match(board, /AreaChart/);
  assert.match(board, /PieChart/);
  assert.match(board, /ScatterChart/);
  assert.match(board, /Tooltip/);
  assert.match(board, /data-chart-legend/);
  assert.match(board, /stackId=\{spec\.stacked \? "stack"/);
  assert.match(board, /data-chart-resize/);
  assert.match(board, /cursor-ns-resize/);
  assert.match(board, /createPortal\(overlay/);
  assert.match(board, /event\.key === "Escape"/);
  assert.match(board, /charts\.map\(/);
  assert.match(board, /data-chart-renderer/);
  assert.match(board, /radial-gradient\(circle at 1px 1px/);
  assert.match(board, /from-background to-transparent/);
  assert.match(board, /h-0\.5 w-8 rounded-full bg-border/);
});

test("chart board uses the requested palette and graph-board chrome", () => {
  for (const color of ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed"]) assert.match(board, new RegExp(color));
  assert.match(board, /var\(--muted-foreground\)/);
  assert.match(board, /var\(--background\)/);
  assert.match(board, /fill: axisColor/);
  assert.doesNotMatch(board, /hsl\(var\(--/);
  assert.match(board, /rounded-lg border border-border\/40 bg-background/);
  assert.match(board, /rounded-md border border-border\/50 bg-background\/90/);
  assert.doesNotMatch(board, /glow/);
});
