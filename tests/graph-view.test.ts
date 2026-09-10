import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultGraphWindow,
  panGraphWindow,
  windowToBoundingBox,
  zoomGraphWindow,
} from "../lib/graph-view";

test("zooms a graph window around the pointer", () => {
  const win = defaultGraphWindow([-6, 6, -4, 4]);
  const next = zoomGraphWindow(win, 150, 80, 300, 160, 0.5);
  assert.equal(Number(next.xmin.toFixed(4)), -3);
  assert.equal(Number(next.xmax.toFixed(4)), 3);
  assert.equal(Number(next.ymin.toFixed(4)), -2);
  assert.equal(Number(next.ymax.toFixed(4)), 2);
});

test("pans a graph window in pixel space", () => {
  const win = defaultGraphWindow([-6, 6, -4, 4]);
  const next = panGraphWindow(win, 150, 0, 300, 160);
  assert.equal(next.xmin, -12);
  assert.equal(next.xmax, 0);
  assert.equal(next.ymin, -4);
  assert.equal(next.ymax, 4);
});

test("maps a window to a JSXGraph bounding box", () => {
  assert.deepEqual(windowToBoundingBox({ xmin: -2, xmax: 4, ymin: -1, ymax: 3 }), [-2, 3, 4, -1]);
});
