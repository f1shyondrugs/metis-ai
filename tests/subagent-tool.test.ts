import assert from "node:assert/strict";
import test from "node:test";
import { subagentMetadataFromTool } from "../lib/subagent-tool";

test("provider-neutral delegate result becomes durable subagent metadata", () => {
  const result = {
    content: [{
      type: "text",
      text: JSON.stringify({
        delegated: true,
        agentId: "job-child-1",
        chatId: "chat-child-1",
        title: "Inspect persistence",
        model: "compatible:glm-5.3",
        mode: "plan",
        prompt: "Inspect persistence without editing.",
        messages: [{ role: "assistant", text: "Found the cache path." }],
      }),
    }],
  };

  const subagent = subagentMetadataFromTool(
    "delegate_subagent",
    { title: "Inspect persistence", prompt: "Inspect persistence without editing." },
    result,
    "subagent",
  );

  assert.equal(subagent?.agentId, "job-child-1");
  assert.equal(subagent?.chatId, "chat-child-1");
  assert.equal(subagent?.title, "Inspect persistence");
  assert.equal(subagent?.model, "compatible:glm-5.3");
  assert.equal(subagent?.mode, "plan");
  assert.equal(subagent?.messages?.[0]?.text, "Found the cache path.");
});

test("non-subagent tools do not get delegation metadata", () => {
  assert.equal(
    subagentMetadataFromTool("read_file", { path: "/tmp/a" }, { content: "x" }, "read"),
    undefined,
  );
});

test("subagent_status does not become durable subagent metadata", () => {
  assert.equal(
    subagentMetadataFromTool(
      "subagent_status",
      { agentId: "job-child-1" },
      { agentId: "job-child-1", chatId: "chat-child-1", status: "running" },
      "subagent",
    ),
    undefined,
  );
});
