import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeDiscoveredContextWindow,
  parseDiscoveredModel,
} from "../lib/providers/discovery";

test("parseDiscoveredModel keeps API context windows and does not infer", () => {
  const grok = parseDiscoveredModel({
    id: "grok-4",
    display_name: "Grok 4",
    context_length: 2_000_000,
  });
  assert.equal(grok?.contextWindow, 2_000_000);
  assert.equal(grok?.contextWindowDiscovered, true);

  const openai = parseDiscoveredModel({
    id: "gpt-5",
    object: "model",
    owned_by: "openai",
  });
  assert.equal(openai?.id, "gpt-5");
  assert.equal(openai?.contextWindow, undefined);
  assert.equal(openai?.contextWindowDiscovered, undefined);
});

test("mergeDiscoveredContextWindow prefers live API, then stored provider metadata, then catalog", () => {
  assert.equal(mergeDiscoveredContextWindow({
    discovered: 2_000_000,
    stored: 128_000,
    catalog: 256_000,
  }), 2_000_000);
  assert.equal(mergeDiscoveredContextWindow({
    stored: 202_752,
    catalog: 200_000,
  }), 202_752);
  assert.equal(mergeDiscoveredContextWindow({
    stored: 202_752,
  }), 202_752);
  assert.equal(mergeDiscoveredContextWindow({
    discovered: 0,
 catalog: 202_752,
 stored: 128_000,
 }), 128_000);
 assert.equal(mergeDiscoveredContextWindow({
 catalog: 400_000,
  }), 400_000);
  assert.equal(mergeDiscoveredContextWindow({}), undefined);
});
