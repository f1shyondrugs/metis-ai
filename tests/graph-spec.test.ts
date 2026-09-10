import assert from "node:assert/strict";
import test from "node:test";
import {
  compileGraphExpression,
  isGraphSource,
  parseGraphDocument,
  serializeGraphDocument,
} from "../lib/graph-spec";

test("graph fences and JSON boards are detected", () => {
  assert.equal(isGraphSource("graph", "{ \"fn\": \"sin(x)\" }"), true);
  assert.equal(isGraphSource("jsxgraph", "{ \"fn\": \"x^2\" }"), true);
  assert.equal(isGraphSource("js", "const x = 1"), false);
  assert.equal(isGraphSource(undefined, "{ \"fn\": \"sin(x)\" }"), true);
});

test("parses one board, many boards, and function lists", () => {
  const single = parseGraphDocument(JSON.stringify({
    title: "Sine",
    bounds: [-6, 6, -2, 2],
    elements: [{ type: "slider", name: "a", min: -2, max: 2, value: 1 }, { type: "function", fn: "a*sin(x)" }],
  }));
  assert.equal(single.boards.length, 1);
  assert.equal(single.boards[0].elements.length, 2);

  const many = parseGraphDocument(JSON.stringify({
    boards: [
      { fn: "sin(x)" },
      { functions: ["x^2", "abs(x)"] },
    ],
  }));
  assert.equal(many.boards.length, 2);
  assert.equal(many.boards[1].elements.length, 2);
});

test("compiles slider expressions and rejects unsafe input", () => {
  const fn = compileGraphExpression("a*sin(x)", ["a"]);
  assert.equal(Number(fn({ x: 0, a: 3 }).toFixed(6)), 0);
  assert.ok(Math.abs(fn({ x: Math.PI / 2, a: 2 }) - 2) < 1e-9);
  assert.throws(() => compileGraphExpression("process.exit()", []), /Unsafe|Unknown/);
  assert.throws(() => compileGraphExpression("sin(foo)", ["a"]), /Unknown symbol/);
});

test("round-trips a graph document through serialize", () => {
  const source = serializeGraphDocument(parseGraphDocument('{"fn":"cos(x)","color":"#2563eb"}'));
  const parsed = parseGraphDocument(source);
  assert.equal(parsed.boards[0].elements[0].type, "function");
  if (parsed.boards[0].elements[0].type === "function") {
    assert.equal(parsed.boards[0].elements[0].fn, "cos(x)");
  }
});
