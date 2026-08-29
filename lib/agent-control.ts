/**
 * Provider-neutral control policy. Keep orchestration semantics here so Cursor,
 * AI SDK providers, Codex, Claude Code and Antigravity do not silently drift.
 * Provider adapters should map these semantics to native controls where they
 * exist (for example Cursor `agents` + `task`) and use Metis MCP fallbacks
 * otherwise.
 */
export const METIS_AGENT_CONTROL_VERSION = 1;

export type ToolContractInput = {
  modeId: string;
  toolNames?: ReadonlyArray<string>;
  provider?: string;
  nativeTools?: boolean;
};

export function toolContractPrompt(input: ToolContractInput): string {
  const names = [...new Set((input.toolNames || []).map((name) => name.trim()).filter(Boolean))].sort();
  const surface = names.length
    ? names.join(", ")
    : input.nativeTools
      ? "provider-native tools (the provider decides the exact names)"
      : "no callable tools";
  const planRule = input.modeId === "plan"
    ? "In Plan mode create exactly one plan workspace in the current chat, then update that same plan; do not create plans from subagents."
    : "In Agent mode do not create a plan workspace unless the user explicitly requests a plan document.";
  const todoRule = input.modeId === "agent"
    ? "For three or more distinct steps, create one short Todo state BEFORE the first mutating action, then keep that same Todo state current as work completes. This is the execution plan; do not start a multi-step edit/deploy first and plan afterward."
    : input.modeId === "plan"
      ? "Use one short Todo checklist for progress only; the persisted plan workspace is the canonical plan."
      : "Do not create a Todo checklist for a single-step answer.";
  return [
    `Tool contract for this run (${input.provider || "provider"}):`,
    `Callable tools: ${surface}. Never call or promise a tool that is not listed or provider-native.`,
    "Use direct Metis core tools such as read_file, list_directory, execute_command, write_file, browser_* and write_todos when they are listed. Do not invent MCP server IDs such as 'metis'; call_mcp_tool is only for an exact server/tool pair returned by search_tools or list_mcp_servers.",
    planRule,
    todoRule,
    "Workspace truth rule: a Metis Plan or Canvas exists ONLY after the Metis MCP create_plan/create_canvas tool returns a successful workspace://plan/... or workspace://canvas/... result. A provider-native file/artifact/brain document is NOT a Metis workspace. Never claim Plan/Canvas creation from write_file or a provider-native artifact.",
    "When the user asks to create, edit, list, or delete a Metis Plan/Canvas, use the exact Metis MCP workspace tools (create_plan, create_canvas, edit_plan, edit_canvas, list_workspaces, delete_plan, delete_canvas). Do not substitute provider-native artifact/file tools.",
    "Tool calls are stateful actions, not narration. Wait for the result, preserve errors, and continue from the returned state.",
    "Prefer Metis MCP / gateway tools over repeating tool names in chat. Native provider tools are a fallback when a Metis tool is not listed. Do not narrate the tool catalog.",
  ].join("\n");
}

export const METIS_SHARED_AGENT_CONTROL = [
  "Metis control contract v1:",
  "- Diagnostics/self-repair: only when the user explicitly asks about Metis itself (fix Metis, read Metis logs/errors): call list_recent_errors first, drill in with read_error_log_detail, and edit/test the repo if asked. Never do this for ordinary task failures. A tool error/timeout during a normal task (browser hung, request timed out, MCP -32001) is a transient infrastructure issue: retry the tool, or reset the browser session with a fresh browser_navigate, then continue the USER'S task. Do not grep/read Metis source code, do not kill system processes, do not spend more than ~2 calls on recovery before resuming the actual task.",
  "- Delegation: delegate bounded independent work instead of copying a giant parent prompt into children. Prefer the provider's native subagent/task primitive when it has one (Cursor task/agents). Otherwise call delegate_subagent, which creates a durable Metis child run. The parent remains coordinator and owns final synthesis.",
  "- Parallel delegation: launch independent delegate_subagent calls with wait=false, keep file ownership non-overlapping, then use subagent_status with the returned agentIds until the required children are terminal before final synthesis. Do not finish while required delegated work is still running.",
  "- Plan/Todo state: plans and todos are current state, not append-only narration. Create one plan, update that same plan with edit_plan, and keep one current write_todos/updateTodos checklist with statuses. Do not create duplicate plan/task surfaces just to report progress.",
  "- Code/context efficiency: establish the correct project/repository root first. Search the smallest plausible directory or symbol scope; never search an entire home/workspace when the repo is already known. Never reread a very large file in full just to locate a symbol: search/index first, then use bounded/ranged reads around the relevant lines. If a broad search times out, narrow it immediately instead of repeating the same broad call. Treat filesystem/repo state as external memory and keep only the slice needed for the current step in model context.",
  "- Web routing: use web_search to discover current public sources, then web_fetch for fast read-only extraction of public pages through the local static scraper. Use the persistent browser_* session for logins, authenticated pages, forms, uploads/downloads, purchases/checkouts, important state-changing workflows, visual verification, or pages that web_fetch marks requiresBrowser. Never try to defeat anti-bot/challenge systems; if static extraction is blocked, move to the normal persistent browser or report the access limitation.",
].join("\n");
