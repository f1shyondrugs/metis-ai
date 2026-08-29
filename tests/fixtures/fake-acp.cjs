#!/usr/bin/env node
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS test fixture
const { createInterface } = require("node:readline");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + String.fromCharCode(10));
  if (msg.method === "initialize") { reply({ protocolVersion: 1, agentCapabilities: {} }); return; }
  if (msg.method === "session/new") { reply({ sessionId: "sess-1" }); return; }
  if (msg.method === "session/prompt") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "list_directory", status: "completed", rawInput: { path: "/tmp" } } } }) + String.fromCharCode(10));
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "listed /tmp" } } } }) + String.fromCharCode(10));
    reply({ stopReason: "end_turn" });
    return;
  }
  if (msg.id !== undefined) reply({});
});
