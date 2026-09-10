import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultChartDocument,
  isChartSource,
  parseChartDocument,
  serializeChartDocument,
} from "../lib/chart-spec";

test("detects chart languages and fenced chart JSON", () => {
  assert.equal(isChartSource("chart", "not JSON"), true);
  assert.equal(isChartSource("charts", "{}"), true);
  assert.equal(isChartSource(undefined, '```json\n{"type":"bar","values":[1,2]}\n```'), true);
  assert.equal(isChartSource("js", "const chart = 1"), false);
});

test("parses pie shortcut and aliases", () => {
  const document = parseChartDocument(JSON.stringify({ kind: "pie", labels: ["A", "B"], values: [3, 7] }));
  assert.deepEqual(document.charts[0], {
    type: "pie",
    x: ["A", "B"],
    labels: ["A", "B"],
    values: [3, 7],
  });
});

test("parses multiple charts and scatter points", () => {
  const document = parseChartDocument(JSON.stringify({ charts: [
    { type: "bar", series: [{ name: "Sales", values: [1, 2] }] },
    { type: "scatter", data: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
  ] }));
  assert.equal(document.charts.length, 2);
  assert.deepEqual(document.charts[1].series, [{ name: "Data", points: [[1, 2], [3, 4]] }]);
});

test("rejects GeoGebra boards, random JSON, unsafe and empty input", () => {
  assert.equal(isChartSource(undefined, '{"fn":"sin(x)"}'), false);
  assert.equal(isChartSource(undefined, '{"elements":[{"type":"slider","name":"a"}]}'), false);
  assert.equal(isChartSource(undefined, '{"bounds":[-1,1,-1,1]}'), false);
  assert.equal(isChartSource(undefined, '{"hello":"world"}'), false);
  assert.throws(() => parseChartDocument(""), /empty/i);
  assert.throws(() => parseChartDocument('{"type":"bar","values":[null]}'), /finite number/i);
  assert.throws(() => parseChartDocument('{"type":"unknown","values":[1]}'), /Unsupported chart type/i);
});

test("serializes one and many charts and round-trips", () => {
  const one = parseChartDocument(serializeChartDocument(defaultChartDocument()));
  assert.equal(one.charts[0].title, "Umsatz");
  const many = parseChartDocument(serializeChartDocument({ charts: [
    { type: "line", values: [1, 2] },
    { type: "donut", labels: ["A"], values: [1] },
  ] }));
  assert.equal(many.charts.length, 2);
});
