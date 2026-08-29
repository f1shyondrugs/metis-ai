import assert from "node:assert/strict";
import test from "node:test";
import { retrieveRelevantFacts } from "../lib/context-layers";

const facts = [
  { id: "server", content: "The home server uses DDR3 ECC LRDIMM memory", tags: ["server", "ram"], updatedAt: "2026-08-25T12:00:00Z" },
  { id: "music", content: "Piano tracks should use a dry solo-piano sound", tags: ["music", "piano"], updatedAt: "2026-08-26T12:00:00Z" },
  { id: "ui", content: "Metis mobile UI should stay clean and compact", tags: ["metis", "mobile", "ui"], updatedAt: "2026-08-24T12:00:00Z" },
];

test("layered memory retrieval selects task-relevant durable facts", () => {
  const selected = retrieveRelevantFacts("Fix the Metis mobile UI and composer", facts, { limit: 2 });
  assert.deepEqual(selected.map((fact) => fact.id), ["ui"]);
});

test("layered global memory has no implicit unrelated fallback", () => {
  assert.deepEqual(retrieveRelevantFacts("weather tomorrow", facts, { limit: 3, fallback: 0 }), []);
});

test("chat working memory can disable fallback so vague turns inject no unrelated facts", () => {
  const selected = retrieveRelevantFacts("und wie ist das?", facts, { limit: 3, fallback: 0 });
  assert.deepEqual(selected, []);
});
