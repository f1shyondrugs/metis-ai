import assert from "node:assert/strict";
import test from "node:test";
import { withoutProviderSessionBindings } from "../lib/providers/session-bindings";

test("revert invalidates provider-native continuation without erasing UI session state", () => {
  const state = {
    input: "draft",
    workspaceOpen: true,
    modeId: "agent",
    providerSessions: {
      "codex-sdk:oauth": {
        execution: "codex-sdk" as const,
        connectionId: "oauth",
        contextOwner: "native" as const,
        lastKnownGoodCursor: "thread-old-context",
        updatedAt: "2026-08-26T12:00:00Z",
      },
    },
  };

  const next = withoutProviderSessionBindings(state);
  assert.equal(next?.input, "draft");
  assert.equal(next?.workspaceOpen, true);
  assert.equal(next?.modeId, "agent");
  assert.equal(next?.providerSessions, undefined);
  assert.ok(state.providerSessions["codex-sdk:oauth"]);
});
