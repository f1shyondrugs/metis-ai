import assert from "node:assert/strict";
import test from "node:test";
import { pinchDistance, pinchMidpoint, viewAfterZoom } from "../lib/notes-gestures";

test("pinch distance and midpoint follow the two touch points", () => {
  assert.equal(pinchDistance({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 }), 5);
  assert.deepEqual(
    pinchMidpoint({ clientX: 0, clientY: 10 }, { clientX: 10, clientY: 0 }),
    { clientX: 5, clientY: 5 },
  );
});

test("zoom keeps the content point under the pinch midpoint", () => {
  const next = viewAfterZoom({ x: 0, y: 0, zoom: 1 }, 100, 80, 2);
  assert.equal(next.zoom, 2);
  assert.equal(next.x, 100 - 100 * 2);
  assert.equal(next.y, 80 - 80 * 2);
});
