import assert from "node:assert/strict";
import test from "node:test";
import {
  compactFileDiff,
  compactToolPreview,
  classifyToolKind,
  isToolRunning,
  layoutAssistantParts,
  planFromToolPayload,
  remoteClientHostnameMap,
  todosFromToolPayload,
  toolCallHeadline,
  activityGroupLabel,
 memoryCardFromPayload,
 toolGroupLabel,
  truncateToolText,
} from "../lib/tool-call-display";

type LayoutTool = { id: string; name?: string; kind?: string; status?: string; input?: string; todos?: Array<{ content: string }> };

test("classifies system context compaction as a tool-like chip", () => {
 assert.equal(classifyToolKind("context_compaction"), "compaction");
});

test("compactToolPreview hides JSON payloads from titles", () => {
  assert.equal(compactToolPreview('{"status":"success","value":{"content":"const x = 1"}}'), undefined);
  assert.equal(compactToolPreview("ls -la src"), "ls -la src");
});

test("toolGroupLabel summarizes Cursor-style file/search/tool counts", () => {
  assert.equal(
    toolGroupLabel([
      { kind: "mcp" },
      { kind: "mcp" },
      { kind: "mcp" },
      { kind: "mcp" },
    ]),
    "4 tools",
  );
  assert.equal(
    toolGroupLabel([
      { name: "read_file", kind: "read" },
      { name: "grep", kind: "read" },
      { name: "search_tools", kind: "mcp" },
    ]),
    "Explored 1 file, 2 searches",
  );
  assert.equal(
    toolGroupLabel([
      { name: "read_file", kind: "read" },
      { name: "list_directory", kind: "read" },
    ]),
    "Explored 2 files",
  );
});

test("isToolRunning recognizes in-flight statuses", () => {
  assert.equal(isToolRunning("running"), true);
  assert.equal(isToolRunning("queued"), true);
  assert.equal(isToolRunning("completed"), false);
});

test("layoutAssistantParts separates glued consecutive sentences", () => {
  const blocks = layoutAssistantParts<LayoutTool>([
    { type: "text", content: "Remote-Tool-Calls beschriftet werden." },
    { type: "text", content: "Ursachen sind klar." },
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "text");
  if (blocks[0]?.type === "text") {
    assert.equal(blocks[0].content, "Remote-Tool-Calls beschriftet werden.\n\nUrsachen sind klar.");
  }
});

test("layoutAssistantParts groups consecutive tools and splits after other content", () => {
  const blocks = layoutAssistantParts<LayoutTool>([
    { type: "thinking", content: "hmm", done: true },
    { type: "text", content: "I will look that up." },
    { type: "tool", id: "1", name: "search_tools", status: "completed" },
    { type: "text", content: "   " },
    { type: "tool", id: "2", name: "call_mcp_tool", status: "running" },
    { type: "text", content: "Here is the answer." },
  ]);
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["thinking", "text", "tools", "text"],
  );
  const tools = blocks[2];
  const reply = blocks[3];
  assert.equal(tools.type, "tools");
  if (tools.type === "tools") {
    assert.deepEqual(tools.tools.map((tool) => tool.id), ["1", "2"]);
  }
  assert.equal(reply.type, "text");
  if (reply.type === "text") {
    assert.equal(reply.content, "Here is the answer.");
  }
});

test("layoutAssistantParts starts a new tool group after text, todos, and other cards", () => {
  const blocks = layoutAssistantParts<LayoutTool>([
    { type: "tool", id: "1", name: "read_file", kind: "read", status: "completed" },
    { type: "tool", id: "2", name: "grep", kind: "read", status: "completed" },
    { type: "text", content: "Next I will update the task list." },
    { type: "tool", id: "3", name: "write_todos", kind: "todo", status: "completed" },
    { type: "tool", id: "4", name: "edit_file", kind: "edit", status: "completed" },
    { type: "tool", id: "5", name: "shell", kind: "shell", status: "completed" },
    { type: "text", content: "Done." },
    { type: "tool", id: "6", name: "search_tools", kind: "mcp", status: "completed" },
  ]);
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["tools", "text", "tools", "tools", "text", "tools"],
  );
  assert.deepEqual(
    blocks
      .filter((block) => block.type === "tools")
      .map((block) => block.type === "tools" ? block.tools.map((tool) => tool.id) : []),
    [["1", "2"], ["3"], ["4", "5"], ["6"]],
  );
});

test("layoutAssistantParts keeps only the latest plan and todo state", () => {
  const blocks = layoutAssistantParts<LayoutTool>([
    { type: "tool", id: "plan-1", name: "create_plan", kind: "plan", status: "completed", input: "old plan" },
    { type: "tool", id: "todo-1", name: "write_todos", kind: "todo", status: "completed", todos: [{ content: "old task" }] },
    { type: "tool", id: "plan-2", name: "edit_plan", kind: "plan", status: "completed", input: "final plan" },
    { type: "tool", id: "todo-2", name: "write_todos", kind: "todo", status: "completed", todos: [{ content: "final task" }] },
  ]);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "tools");
  if (blocks[0]?.type === "tools") {
    assert.deepEqual(blocks[0].tools.map((tool) => tool.id), ["plan-2", "todo-2"]);
  }
});

test("layoutAssistantParts keeps a running intermediate plan out of the finished-plan path", () => {
  const blocks = layoutAssistantParts<LayoutTool>([
    { type: "tool", id: "plan-running", name: "create_plan", kind: "plan", status: "in_progress", input: '{"content":"Draft"}' },
    { type: "tool", id: "tool-after", name: "read_file", kind: "read", status: "completed" },
  ]);
  const planBlock = blocks.find((block) =>
    block.type === "tools" && block.tools.some((tool) => tool.id === "plan-running"));
  assert.equal(planBlock?.type, "tools");
  if (planBlock?.type === "tools") {
    const plan = planBlock.tools.find((tool) => tool.id === "plan-running");
    assert.equal(plan?.status, "in_progress");
  }
});

test("planFromToolPayload deeply unwraps nested plan responses", () => {
  const plan = planFromToolPayload(JSON.stringify({
    status: "success",
    result: JSON.stringify({
      value: {
        plan: { id: "plan-42", title: "Release plan", content: "Ship it." },
      },
    }),
  }));
  assert.deepEqual(plan, {
    title: "Release plan",
    content: "Ship it.",
    workspaceLink: "workspace://plan/plan-42",
  });
});

test("layoutAssistantParts presents todo directly below the latest plan", () => {
  const blocks = layoutAssistantParts<LayoutTool>([
    { type: "tool", id: "todo-final", name: "write_todos", kind: "todo", status: "completed", todos: [{ content: "Ship" }] },
    { type: "tool", id: "plan-final", name: "create_plan", kind: "plan", status: "completed", input: "plan" },
  ]);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "tools");
  if (blocks[0]?.type === "tools") {
    assert.deepEqual(blocks[0].tools.map((tool) => tool.kind), ["plan", "todo"]);
  }
});

test("toolCallHeadline uses the local shell command as the title", () => {
  const headline = toolCallHeadline({
    name: "execute_command",
    kind: "shell",
    input: JSON.stringify({ command: "ollama pull x" }),
  });
  assert.equal(headline.title, "Ran ollama pull x");
  assert.equal(headline.remote, undefined);
});

test("toolCallHeadline unwraps call_mcp_tool execute_command on a remote client", () => {
  const headline = toolCallHeadline({
    name: "call_mcp_tool",
    kind: "mcp",
    input: JSON.stringify({
      tool: "execute_command",
      arguments: { command: "ollama pull x", target: "client:abc" },
    }),
    hostnames: { abc: "DESKTOP-PD4H5G9" },
  });
  assert.equal(headline.title, "DESKTOP-PD4H5G9: Ran ollama pull x");
  assert.equal(headline.remote, true);
});

test("toolCallHeadline labels a remote read with hostname and path", () => {
  const headline = toolCallHeadline({
    name: "call_mcp_tool",
    kind: "mcp",
    input: JSON.stringify({
      tool: "read_file",
      arguments: { path: "C:\\Users\\sam\\file.txt", target: "client:abc" },
    }),
    hostnames: { abc: "DESKTOP-PD4H5G9" },
  });
  assert.equal(headline.title, "DESKTOP-PD4H5G9: Read file.txt");
  assert.equal(headline.remote, true);
});

test("toolCallHeadline uses the nested MCP tool name instead of call_mcp_tool", () => {
  const headline = toolCallHeadline({
    name: "call_mcp_tool",
    kind: "mcp",
    input: JSON.stringify({ tool: "search_tools", arguments: { query: "browser" } }),
  });
  assert.equal(headline.title, "Searched MCP tools");
  assert.doesNotMatch(headline.title, /call_mcp_tool/i);
  assert.equal(headline.preview, "browser");
});

test("remoteClientHostnameMap maps client ids and windows pc alias", () => {
  const map = remoteClientHostnameMap([
    { id: "abc", hostname: "DESKTOP-PD4H5G9", os: "windows" },
  ]);
  assert.equal(map.abc, "DESKTOP-PD4H5G9");
  assert.equal(map.pc, "DESKTOP-PD4H5G9");
  assert.equal(
    toolCallHeadline({
      name: "execute_command",
      kind: "mcp",
      input: JSON.stringify({ command: "hostname", target: "pc" }),
      hostnames: map,
    }).title,
    "DESKTOP-PD4H5G9: Ran hostname",
  );
});

test("toolCallHeadline includes read line ranges and grep patterns", () => {
  assert.equal(
    toolCallHeadline({
      name: "read_file",
      kind: "read",
      input: JSON.stringify({ path: "/home/samuel/metis-ai/app/globals.css", offset: 280, limit: 150 }),
    }).title,
    "Read globals.css L280-429",
  );
  assert.equal(
    toolCallHeadline({
      name: "grep",
      kind: "read",
      input: JSON.stringify({ pattern: "toolGroupLabel", path: "/home/samuel/metis-ai" }),
    }).title,
    "Grepped toolGroupLabel",
  );
});

test("write_todos classifies as todo for the Tasks card", () => {
  assert.equal(classifyToolKind("write_todos"), "todo");
  assert.equal(classifyToolKind("updateTodos"), "todo");
});

test("todosFromToolPayload reads todo lists from tool JSON", () => {
  const todos = todosFromToolPayload(
    JSON.stringify({
      todos: [
        { id: "1", content: "Fix composer", status: "completed" },
        { content: "Group tool calls", status: "in_progress" },
      ],
    }),
  );
  assert.equal(todos?.length, 2);
  assert.equal(todos?.[0]?.content, "Fix composer");
  assert.equal(todosFromToolPayload('{"status":"ok"}'), undefined);
});

test("call_mcp_tool write_todos unwraps string arguments into a Tasks card", () => {
  const input = JSON.stringify({
    server: "gateway",
    toolName: "write_todos",
    arguments: JSON.stringify({
      todos: [
        { id: "diag", content: "Diagnose", status: "completed" },
        { id: "fix", content: "Fix todos", status: "in_progress" },
      ],
    }),
  });
  const todos = todosFromToolPayload(input);
  assert.equal(todos?.length, 2);
  assert.equal(classifyToolKind("call_mcp_tool", input), "todo");
  const blocks = layoutAssistantParts<LayoutTool>([
    { type: "tool", id: "1", name: "call_mcp_tool", kind: "mcp", input, status: "completed" },
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "tools");
  if (blocks[0]?.type === "tools") {
    assert.equal(blocks[0].tools[0]?.kind, "todo");
    assert.equal(blocks[0].tools[0]?.todos?.length, 2);
  }
});

test("todosFromToolPayload unwraps Cursor mcp write_todos payloads", () => {
  const todos = todosFromToolPayload(
    JSON.stringify({
      toolName: "write_todos",
      args: {
        todos: [
          { content: "Fix tokens", status: "inProgress" },
        ],
      },
    }),
  );
  assert.equal(todos?.length, 1);
  assert.equal(todos?.[0]?.status, "in_progress");
  assert.equal(classifyToolKind("mcp", {
    toolName: "write_todos",
    args: { todos: [{ content: "Fix tokens", status: "pending" }] },
  }), "todo");
});

test("compactFileDiff shows only the changed hunk", () => {
  const before = ["keep", "old line", "tail"].join("\n");
  const after = ["keep", "new line", "tail"].join("\n");
  const diff = compactFileDiff(before, after, 1);
  assert.match(diff, /^-old line$/m);
  assert.match(diff, /^\+new line$/m);
  assert.equal(diff.includes("Before:"), false);
});

test("truncateToolText keeps head and tail", () => {
  const value = `${"a".repeat(2000)}UNIQUE_MIDDLE${"b".repeat(2000)}`;
  const truncated = truncateToolText(value, 1200);
  assert.ok(truncated.length < value.length);
  assert.match(truncated, /chars omitted/);
  assert.equal(truncated.includes("UNIQUE_MIDDLE"), false);
});

test("activityGroupLabel prefixes thought duration onto tool summaries", () => {
 assert.equal(
 activityGroupLabel(
 [{ name: "read_file", kind: "read" }, { name: "list_directory", kind: "read" }],
 { done: true, durationMs: 3000 },
 ),
 "Thought for 3s — Explored 2 files",
 );
});

test("layoutAssistantParts attaches thinking to the following tool group", () => {
 const blocks = layoutAssistantParts<LayoutTool>([
 { type: "thinking", content: "look around", done: true, durationMs: 2500 },
 { type: "tool", id: "1", name: "read_file", kind: "read", status: "completed" },
 { type: "tool", id: "2", name: "list_directory", kind: "read", status: "completed" },
 ]);
 assert.equal(blocks.length, 1);
 assert.equal(blocks[0]?.type, "tools");
 if (blocks[0]?.type === "tools") {
 assert.equal(blocks[0].tools.length, 2);
 assert.equal(blocks[0].thinking?.content, "look around");
 assert.equal(blocks[0].thinking?.durationMs, 2500);
 }
});

test("layoutAssistantParts keeps todos visible outside the following tool activity", () => {
  const blocks = layoutAssistantParts<LayoutTool>([
    { type: "thinking", content: "plan next steps", done: true, durationMs: 3000 },
    { type: "tool", id: "1", name: "write_todos", kind: "todo", status: "completed" },
    { type: "tool", id: "2", name: "read_file", kind: "read", status: "completed" },
    { type: "tool", id: "3", name: "list_directory", kind: "read", status: "completed" },
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.type, "tools");
  assert.equal(blocks[1]?.type, "tools");
  if (blocks[0]?.type === "tools") {
    assert.deepEqual(blocks[0].tools.map((tool) => tool.name), ["write_todos"]);
  }
  if (blocks[1]?.type === "tools") {
    assert.deepEqual(blocks[1].tools.map((tool) => tool.name), ["read_file", "list_directory"]);
    assert.equal(blocks[1].thinking?.durationMs, 3000);
  }
});

test("layoutAssistantParts groups memory with following file tools and thinking", () => {
  const blocks = layoutAssistantParts<LayoutTool>([
    { type: "thinking", content: "remember this", done: true, durationMs: 1200 },
    { type: "tool", id: "1", name: "add_memory", kind: "memory", status: "completed" },
    { type: "tool", id: "2", name: "read_file", kind: "read", status: "completed" },
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "tools");
  if (blocks[0]?.type === "tools") {
    assert.deepEqual(blocks[0].tools.map((tool) => tool.name), ["add_memory", "read_file"]);
    assert.equal(blocks[0].thinking?.content, "remember this");
  }
});

test("memoryCardFromPayload shows saved content instead of raw json", () => {
  const card = memoryCardFromPayload(
    "add_memory",
    JSON.stringify({ content: "Cursor context must stay settable" }),
    JSON.stringify({ memory: { id: "1", content: "Cursor context must stay settable" } }),
  );
  assert.equal(card.title, "Saved memory");
  assert.equal(card.body, "Cursor context must stay settable");
});

test("memoryCardFromPayload lists memories without dumping json", () => {
  const card = memoryCardFromPayload(
    "list_memories",
    "{}",
    JSON.stringify({ memories: [{ content: "one" }, { content: "two" }] }),
  );
  assert.equal(card.title, "Memories");
  assert.ok(card.body.includes("one"));
  assert.ok(card.body.includes("two"));
  assert.equal(/memories/.test(card.body), false);
});

test("toolGroupLabel counts memory updates", () => {
  assert.equal(
    activityGroupLabel(
      [{ name: "add_memory", kind: "memory" }, { name: "read_file", kind: "read" }],
      { done: true, durationMs: 3000 },
    ),
    "Thought for 3s — Explored 1 file, 1 memory",
  );
});



test("layoutAssistantParts never folds the latest Tasks state into edit activity", () => {
  const blocks = layoutAssistantParts<LayoutTool>([
    { type: "tool", id: "todo", name: "write_todos", kind: "todo", status: "completed", todos: [{ content: "Ship UI" }] },
    { type: "tool", id: "edit", name: "edit_file", kind: "edit", status: "completed" },
    { type: "tool", id: "shell", name: "execute_command", kind: "shell", status: "completed" },
  ]);
  const toolBlocks = blocks.filter((block) => block.type === "tools");
  assert.equal(toolBlocks.length, 2);
  if (toolBlocks[0]?.type === "tools") assert.deepEqual(toolBlocks[0].tools.map((tool) => tool.kind), ["todo"]);
  if (toolBlocks[1]?.type === "tools") assert.deepEqual(toolBlocks[1].tools.map((tool) => tool.kind), ["edit", "shell"]);
});
