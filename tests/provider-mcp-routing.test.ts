import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildMcpContext } from "../lib/mcp";

test("buildMcpContext serializes a modePolicy object", () => {
  const context = buildMcpContext({
    chatId: "chat-1",
    modeId: "agent",
    modePolicy: {
      allowedCategories: ["read", "edit"],
      toolOverrides: { wait: "deny" },
    },
  });
  assert.equal(context.modeId, "agent");
  assert.equal(typeof context.modePolicy, "string");
  assert.deepEqual(JSON.parse(context.modePolicy || ""), {
    allowedCategories: ["read", "edit"],
    toolOverrides: { wait: "deny" },
  });
});

test("buildMcpContext keeps a string modePolicy and defaults missing toolOverrides", () => {
  assert.equal(buildMcpContext({ modePolicy: '{"allowedCategories":["read"]}' }).modePolicy, '{"allowedCategories":["read"]}');
  const serialized = buildMcpContext({
    modePolicy: { allowedCategories: ["browser"] },
  });
  assert.deepEqual(JSON.parse(serialized.modePolicy || ""), {
    allowedCategories: ["browser"],
    toolOverrides: {},
  });
});

test("alternative providers prefer the live HTTP MCP gateway over a cold stdio spawn", () => {
  const source = readFileSync(new URL("../lib/providers/adapters/provider-support.ts", import.meta.url), "utf8");
  const bridge = readFileSync(new URL("../lib/mcp-bridge.ts", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../worker.ts", import.meta.url), "utf8");
  assert.match(source, /mcpBridgeHttpTools/);
  assert.match(source, /servers\.gateway\.type === "http"/);
  assert.match(bridge, /export async function mcpBridgeHttpTools/);
  assert.match(bridge, /StreamableHTTPClientTransport/);
  assert.match(worker, /void warmLiveMcp\(\)/);
  assert.match(worker, /checkGatewayHealth/);
});
