import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultParamsForModel,
  modelParametersForModel,
  providerNativeParams,
  sanitizeModelParams,
  stripRemovedModelParams,
} from "../lib/model-params";

test("known context metadata does not invent a provider context selector", () => {
  const parameters = modelParametersForModel({
    id: "gpt-5.6-luna",
    contextWindow: 1_000_000,
    parameters: [],
  });
  assert.equal(parameters.find((parameter) => parameter.id === "context"), undefined);
  assert.equal(defaultParamsForModel({ id: "gpt-5.6-luna", contextWindow: 1_000_000 }).some((param) => param.id === "context"), false);
});

test("provider-advertised contextWindow choices are normalized and ordered first", () => {
  const parameters = modelParametersForModel({
    id: "claude-sonnet-5",
    contextWindow: 1_000_000,
    parameters: [
      {
        id: "fast",
        values: [{ value: "false" }, { value: "true" }],
      },
      {
        id: "reasoning",
        displayName: "Effort",
        values: [{ value: "low" }, { value: "high" }],
      },
      {
        id: "contextWindow",
        displayName: "Context Window",
        values: [{ value: "200k", displayName: "200K" }, { value: "1m", displayName: "1M" }],
      },
    ],
    defaultParams: [{ id: "contextWindow", value: "200k" }],
  });
  assert.equal(parameters[0]?.id, "context");
  assert.equal(parameters[1]?.id, "effort");
  assert.deepEqual(parameters[0]?.values, [
    { value: "200k", displayName: "200K" },
    { value: "1m", displayName: "1M" },
  ]);
  assert.deepEqual(defaultParamsForModel({
    id: "claude-sonnet-5",
    contextWindow: 1_000_000,
    parameters: [{ id: "contextWindow", values: [{ value: "200k" }, { value: "1m" }] }],
    defaultParams: [{ id: "contextWindow", value: "200k" }],
  }), [{ id: "context", value: "200k" }]);
});

test("stored uncensored selections are stripped", () => {
  assert.deepEqual(
    stripRemovedModelParams([
      { id: "context", value: "max" },
      { id: "uncensored", value: "true" },
      { id: "effort", value: "high" },
    ]),
    [
      { id: "context", value: "max" },
      { id: "effort", value: "high" },
    ],
  );
});

test("provider reasoning and fast parameters are normalized without inventing values", () => {
  const parameters = modelParametersForModel({
    id: "gpt-5.6-luna",
    parameters: [
      {
        id: "reasoning",
        displayName: "Effort",
        values: [{ value: "low" }, { value: "high" }],
      },
      {
        id: "fast",
        values: [{ value: "false" }, { value: "true" }],
      },
    ],
  });
  assert.equal(parameters.find((parameter) => parameter.id === "effort")?.displayName, "Reasoning");
  assert.deepEqual(parameters.find((parameter) => parameter.id === "fast")?.values, [
    { value: "false" },
    { value: "true" },
  ]);
  assert.equal(parameters.some((parameter) => parameter.id === "uncensored"), false);
});

test("invalid and Metis-only parameters do not reach native providers", () => {
  const model = {
    id: "gpt-5.6",
    parameters: [{ id: "effort", values: [{ value: "low" }, { value: "high" }] }],
  };
  assert.deepEqual(sanitizeModelParams(model, [
    { id: "effort", value: "high" },
    { id: "effort", value: "invalid" },
  ]), [
    { id: "effort", value: "high" },
  ]);
  assert.deepEqual(providerNativeParams(model, [
    { id: "effort", value: "high" },
    { id: "context", value: "max" },
    { id: "unknown", value: "value" },
  ]), [{ id: "effort", value: "high" }]);
});


test("explicit provider values and concrete variants are preserved without fabricated max", () => {
 const context = modelParametersForModel({
 contextWindow: 1_000_000,
 parameters: [{ id: "context", values: [{ value: "unlimited" }, { value: "invalid" }] }],
 variants: [[{ id: "context", value: "272k" }]],
 }).find((parameter) => parameter.id === "context");
 assert.deepEqual(context?.values, [
   { value: "unlimited", displayName: "1M" },
   { value: "272k" },
 ]);
 assert.deepEqual(sanitizeModelParams({ parameters: [{ id: "effort", values: [{ value: "low" }] }] }, [
 { id: "effort", value: "low" },
 { id: "effort", value: "invalid" },
 null as never,
 ]), [{ id: "effort", value: "low" }]);
});

test("cursor models keep variant context options without a catalog window", () => {
 const context = modelParametersForModel({
 id: "grok-4.6",
 parameters: [{ id: "context", values: [{ value: "272k" }, { value: "1m" }, { value: "max" }] }],
 variants: [[{ id: "context", value: "272k" }], [{ id: "context", value: "1m" }]],
 }).find((parameter) => parameter.id === "context");
 assert.ok(context);
 assert.ok(context?.values.some((value) => value.value === "272k"));
 assert.ok(context?.values.some((value) => value.value === "1m" || value.value === "max"));
});

test("models without provider context options do not get a fabricated context row", () => {
  const context = modelParametersForModel({ id: "grok-4.6", displayName: "Grok 4.6" }).find((parameter) => parameter.id === "context");
  assert.equal(context, undefined);
});

test("native provider params keep context only when the provider owns that selector", () => {
  const params = [{ id: "context", value: "1m" }, { id: "effort", value: "high" }];
  assert.deepEqual(providerNativeParams(params), [{ id: "effort", value: "high" }]);
  assert.deepEqual(providerNativeParams(params, { includeContext: true }), params);
});



test("OpenAI-compatible models get usable reasoning options when discovery exposes only an id", () => {
  const generic = { id: "custom-reasoner", providerId: "compatible" };
  assert.deepEqual(
    modelParametersForModel(generic).find((parameter) => parameter.id === "effort")?.values,
    [
      { value: "none", displayName: "Provider default" },
      { value: "low", displayName: "Low" },
      { value: "medium", displayName: "Medium" },
      { value: "high", displayName: "High" },
    ],
  );
  assert.deepEqual(defaultParamsForModel(generic), [{ id: "effort", value: "none" }]);
});

test("GLM-5.3 compatible models expose the provider's low/high/max effort ladder", () => {
  const glm = { id: "glm-5.3", providerId: "compatible" };
  assert.deepEqual(
    modelParametersForModel(glm).find((parameter) => parameter.id === "effort")?.values,
    [
      { value: "low", displayName: "Low" },
      { value: "high", displayName: "High" },
      { value: "max", displayName: "Max" },
    ],
  );
  assert.deepEqual(defaultParamsForModel(glm), [{ id: "effort", value: "max" }]);
});
