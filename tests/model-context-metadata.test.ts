import assert from "node:assert/strict";
import test from "node:test";
import {
  contextRegistryProviderCandidates,
  lookupRegistryContextMetadata,
  resolveModelContextMetadata,
} from "../lib/model-context-metadata";

const zaiCoding = {
  providerKey: "compatible",
  slug: "zai-coding",
  label: "Z.AI Coding",
  baseUrl: "https://api.z.ai/api/coding/paas/v4",
};

test("custom compatible APIs resolve context metadata from their actual upstream registry", () => {
  assert.ok(contextRegistryProviderCandidates(zaiCoding).includes("zai-coding-plan"));
  const metadata = lookupRegistryContextMetadata(zaiCoding, "glm-5.3");
  assert.equal(metadata.contextWindow, 1_000_000);
  assert.equal(metadata.maxOutputTokens, 131_072);
  assert.equal(metadata.source, "registry");
});

test("provider-reported context wins stored, registry and catalog metadata", () => {
  const metadata = resolveModelContextMetadata({
    connection: zaiCoding,
    modelId: "glm-5.3",
    providerContextWindow: 777_777,
    storedContextWindow: 888_888,
    storedContextWindowSource: "stored-provider",
    catalogContextWindow: 999_999,
  });
  assert.equal(metadata.contextWindow, 777_777);
  assert.equal(metadata.source, "provider");
});

test("stored provider metadata wins registry/catalog when live model listing omits the limit", () => {
  const metadata = resolveModelContextMetadata({
    connection: zaiCoding,
    modelId: "glm-5.3",
    storedContextWindow: 888_888,
    storedContextWindowSource: "provider",
    catalogContextWindow: 999_999,
  });
  assert.equal(metadata.contextWindow, 888_888);
  assert.equal(metadata.source, "provider");
});

test("legacy unproven stored limits do not override a known upstream registry", () => {
  const metadata = resolveModelContextMetadata({
    connection: zaiCoding,
    modelId: "glm-5.3",
    storedContextWindow: 123_456,
    catalogContextWindow: 200_000,
  });
  assert.equal(metadata.contextWindow, 1_000_000);
  assert.equal(metadata.source, "registry");
});

test("unknown compatible endpoints do not borrow a context limit from an unrelated provider", () => {
  const metadata = lookupRegistryContextMetadata({
    providerKey: "compatible",
    slug: "my-local-gateway",
    label: "My Gateway",
    baseUrl: "https://models.example.test/v1",
  }, "glm-5.3");
  assert.equal(metadata.contextWindow, undefined);
});
