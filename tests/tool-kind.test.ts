import assert from "node:assert/strict";
import test from "node:test";
import { classifyTool, parseAutomationCard, resolveMcpToolName, toolDetailFromArgs } from "../lib/tool-kind";

test("subagent status and wait tools are not classified as subagents", () => {
  assert.equal(classifyTool("subagent_status"), "mcp");
  assert.equal(classifyTool("subagent_cancel"), "mcp");
  assert.equal(classifyTool("delegate_subagent"), "subagent");
  assert.equal(classifyTool("task"), "subagent");
});

test("web research tools are classified as browser instead of generic read", () => {
  assert.equal(classifyTool("web_search"), "browser");
  assert.equal(classifyTool("WebSearch"), "browser");
  assert.equal(classifyTool("web_reader"), "browser");
  assert.equal(classifyTool("WebFetch"), "browser");
  assert.equal(classifyTool("x_search"), "browser");
  assert.equal(classifyTool("grep"), "read");
  assert.equal(classifyTool("semSearch"), "read");
  assert.equal(classifyTool("mcp"), "mcp");
});

test("automation tools are classified as automation instead of list/edit/other", () => {
  assert.equal(classifyTool("create_automation"), "automation");
  assert.equal(classifyTool("list_automations"), "automation");
  assert.equal(classifyTool("update_automation"), "automation");
  assert.equal(classifyTool("pause_automation"), "automation");
  assert.equal(classifyTool("resume_automation"), "automation");
  assert.equal(classifyTool("delete_automation"), "automation");
});

test("CallMcpTool wrappers unwrap nested MCP tool names", () => {
  assert.equal(resolveMcpToolName("CallMcpTool", { toolName: "create_automation" }), "create_automation");
  assert.equal(classifyTool("CallMcpTool", { server: "ai-chat-universal", toolName: "create_automation" }), "automation");
  assert.equal(classifyTool("call_mcp_tool", { toolName: "create_plan" }), "plan");
  assert.equal(classifyTool("call_mcp_tool"), "mcp");
});

test("create_automation tool results become Created Automation cards", () => {
  const card = parseAutomationCard(
    "CallMcpTool",
    JSON.stringify({
      content: [{
        type: "text",
        text: JSON.stringify({
          automation: {
            id: "auto-1",
            name: "Nightly backup",
            prompt: "Run the backup",
            schedule: { kind: "interval", everyMinutes: 60 },
          },
          automationLink: "automation://auto-1",
        }),
      }],
    }),
    JSON.stringify({
      server: "ai-chat-universal",
      toolName: "create_automation",
      arguments: {
        name: "Nightly backup",
        prompt: "Run the backup",
        schedule: { kind: "interval", everyMinutes: 60 },
      },
    }),
  );
  assert.equal(card?.actionLabel, "Created Automation");
  assert.equal(card?.id, "auto-1");
  assert.equal(card?.title, "Nightly backup");
  assert.equal(card?.automationLink, "automation://auto-1");
  assert.equal(card?.scheduleLabel, "Every 60 minutes");
  assert.equal(parseAutomationCard("CallMcpTool", { toolName: "list_automations" }, { automations: [] }), null);
});

test("tool details prefer the query or URL the user should see", () => {
  assert.equal(
    toolDetailFromArgs({ query: "how to create a github organization" }),
    "how to create a github organization",
  );
  assert.equal(toolDetailFromArgs({ url: "https://docs.github.com" }), "https://docs.github.com");
  assert.equal(toolDetailFromArgs({ command: "ls" }), "ls");
});
