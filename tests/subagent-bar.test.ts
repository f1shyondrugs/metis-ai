import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupeChatBarSubagents,
  isBarSubagentLive,
  isChatBarSubagent,
  isSubagentControlName,
  isSubagentSpawnName,
} from "../lib/subagent-bar";

test("status tools are not chat-bar subagents even with an agentId", () => {
  assert.equal(isSubagentControlName("subagent_status"), true);
  assert.equal(isSubagentSpawnName("subagent_status"), false);
  assert.equal(
    isChatBarSubagent({
      name: "subagent_status",
      kind: "subagent",
      subagent: { agentId: "job-1", chatId: "chat-1" },
    }),
    false,
  );
  assert.equal(
    isChatBarSubagent({
      name: "delegate_subagent",
      kind: "subagent",
      subagent: { agentId: "job-1", chatId: "chat-1" },
    }),
    true,
  );
});

test("chat bar keeps one chip per child agent", () => {
  const tools = dedupeChatBarSubagents([
    { id: "spawn", subagent: { agentId: "job-1", chatId: "chat-1" } },
    { id: "status", subagent: { agentId: "job-1", chatId: "chat-1" } },
  ]);
  assert.deepEqual(tools.map((tool) => tool.id), ["spawn"]);
});

test("a completed spawn stays live while the child run is waiting", () => {
  assert.equal(
    isBarSubagentLive(
      { status: "completed", subagent: { chatId: "chat-1" }, sourceMessageIsLatestAssistant: true },
      "waiting_for_user",
      () => false,
    ),
    true,
  );
  assert.equal(
    isBarSubagentLive(
      { status: "completed", subagent: { chatId: "chat-1" }, sourceMessageIsLatestAssistant: true },
      "completed",
      () => false,
    ),
    false,
  );
});
