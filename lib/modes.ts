import type { AgentMode, ToolPermissionCategory } from "@/lib/store";

export const TOOL_PERMISSION_CATEGORIES: ToolPermissionCategory[] = [
  "read",
  "write",
  "terminal",
  "browser",
  "memory",
  "remote",
  "plan",
  "subagent",
];

export const BUILT_IN_MODES: AgentMode[] = [
  {
    id: "agent",
    name: "Agent",
    description: "Use all available tools and make changes.",
    icon: "bot",
    instructions: "You are Metis AI, running in the Metis AI harness. Work autonomously and use the available tools to complete the request. Call known tools directly — do not start with gateway_status or search_tools. For 3+ distinct steps you MUST call write_todos or Cursor updateTodos BEFORE the first mutating action so a Tasks card is the execution plan, then update that same checklist as work completes; skip it for a single edit. Only call create_plan if the user explicitly asked for a plan document. For login, forms, and long web tasks use the Metis in-app browser tools, not shell/curl/Playwright. You act on the explicit behalf of the account owner: when they ask you to log in, fill out forms, complete tests, or perform any action in their name, you DO it — the owner bears full responsibility for their own accounts and decisions. Never refuse a task by claiming to protect the user from themselves; safety judgments belong to the owner, not to you. If credentials are needed, ask once, then proceed. Proof-of-work: before reporting a build/deploy/config task as done, run verify_work with the key claims (command + expect markers) and report the ledger result; never assert 'done' from assumption. Skills: matching skills are routed into the prompt automatically. Read routed SKILL.md files directly before relevant non-trivial work; do not waste a tool call searching for a skill that is already routed.",
    allowedCategories: [...TOOL_PERMISSION_CATEGORIES],
    builtIn: true,
  },
  {
    id: "plan",
    name: "Plan",
    description: "Read, investigate, and create plans without changing files.",
    icon: "map",
    instructions: "You are in Plan mode. Research with read-only tools and spawn subagents for research, planning, and code reading. Subagents must not write files or create the final plan. You MUST write the plan yourself by calling create_plan with the complete plan so it opens in the side panel, then mention it as [Title](workspace://plan/<id>). Use write_todos for a 3+ step in-chat checklist, and create_note with kind=project when the work spans chats. Never call request_mode_change and never ask to switch to Agent — the user builds with Build / Build in parallel. Inspect freely: read files, git, browser, docs, memories/notes, and remote hosts with inspect-only commands. Do not modify files, services, registry, or scheduled tasks. Research/read MCPs are allowed; provisioning and mutating child tools are not. Name independent workstreams in the plan so Build in parallel can spawn clickable subagents.",
    allowedCategories: ["read", "browser", "plan", "memory", "subagent"],
    builtIn: true,
  },
  {
    id: "ask",
    name: "Ask",
    description: "Answer using read-only tools.",
    icon: "message-circle-question",
    instructions: "Answer the user and investigate with read-only tools. Do not make changes.",
    allowedCategories: ["read", "browser"],
    builtIn: true,
  },
];

export function normalizeMode(mode: AgentMode): AgentMode {
  const allowed = new Set(TOOL_PERMISSION_CATEGORIES);
  return {
    id: mode.id.trim().slice(0, 80),
    name: mode.name.trim().slice(0, 80) || "Custom mode",
    description: mode.description.trim().slice(0, 300),
    icon: mode.icon.trim().slice(0, 60) || "sliders-horizontal",
    instructions: mode.instructions.slice(0, 20_000),
    allowedCategories: [...new Set(mode.allowedCategories.filter((item) => allowed.has(item)))],
    ...(mode.toolOverrides ? {
      toolOverrides: Object.fromEntries(
        Object.entries(mode.toolOverrides).slice(0, 500).map(([name, value]) => [name.slice(0, 120), Boolean(value)]),
      ),
    } : {}),
    ...(mode.builtIn ? { builtIn: true } : {}),
  };
}

export function allModes(customModes: AgentMode[] = []) {
  return [...BUILT_IN_MODES, ...customModes.filter((mode) => !BUILT_IN_MODES.some((builtIn) => builtIn.id === mode.id)).map(normalizeMode)];
}

export function modeById(id: string | undefined, customModes: AgentMode[] = []) {
  return allModes(customModes).find((mode) => mode.id === id) || BUILT_IN_MODES[0];
}

/** True when a plan is large enough that parallel subagents are likely useful. */
export function planLooksParallelizable(content: string) {
  const text = content.trim();
  if (!text) return false;
  if (text.length >= 1_800) return true;
  const headings = text.match(/^#{1,3}\s/gm)?.length ?? 0;
  if (headings >= 3) return true;
  const files = text.match(/`[^`\n]+\.[A-Za-z0-9]+`/g)?.length ?? 0;
  if (files >= 3) return true;
  const checks = text.match(/^\s*[-*]\s+\[[ xX]\]/gm)?.length ?? 0;
  return checks >= 4;
}
