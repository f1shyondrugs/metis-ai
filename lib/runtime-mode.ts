export const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export function normalizeRuntimeMode(value: unknown): RuntimeMode {
  return typeof value === "string" && (RUNTIME_MODES as readonly string[]).includes(value)
    ? (value as RuntimeMode)
    : DEFAULT_RUNTIME_MODE;
}

export function runtimeModeForChat(chat: { runtimeMode?: unknown }): RuntimeMode {
  return normalizeRuntimeMode(chat.runtimeMode);
}

/** Codex SDK ThreadOptions mapping. */
export const RUNTIME_MODE_TO_CODEX: Record<RuntimeMode, {
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
}> = {
  "approval-required": { sandboxMode: "read-only", approvalPolicy: "untrusted" },
  "auto-accept-edits": { sandboxMode: "workspace-write", approvalPolicy: "on-request" },
  "auto": { sandboxMode: "workspace-write", approvalPolicy: "on-request" },
  "full-access": { sandboxMode: "danger-full-access", approvalPolicy: "never" },
};

/** Claude Agent SDK permission mapping. */
export const RUNTIME_MODE_TO_CLAUDE_PERMISSION: Record<RuntimeMode, {
  permissionMode: "default" | "acceptEdits" | "bypassPermissions";
  canUseToolRequired: boolean;
}> = {
  "approval-required": { permissionMode: "default", canUseToolRequired: true },
  "auto-accept-edits": { permissionMode: "acceptEdits", canUseToolRequired: false },
  "auto": { permissionMode: "acceptEdits", canUseToolRequired: false },
  "full-access": { permissionMode: "bypassPermissions", canUseToolRequired: false },
};

export type ApprovalDecision = "allow" | "allow-session" | "deny";

/** Canonical prefix key shared by Claude approvals and MCP gateway approvals. */
export function approvalPatternFor(toolName: string, input: unknown): string {
  const name = String(toolName || "").trim();
  const rawInput = String(
    typeof input === "string"
      ? input
      : JSON.stringify(input ?? {}),
  ).trim();
  return `${name}:${rawInput}`.slice(0, 2_000);
}

export function shouldAutoApprove(patterns: readonly string[] | undefined, toolName: string, input: unknown): boolean {
  if (!patterns?.length) return false;
  const target = approvalPatternFor(toolName, input);
  return patterns.some((pattern) => target.startsWith(String(pattern || "").trim().slice(0, 2_000)));
}

/** Pure gate shared by gateway execution and focused tests. */
export function runtimeModeRequiresApproval(
  runtimeMode: unknown,
  toolCategory: "read" | "write" | "terminal" | "browser" | "memory" | "remote" | "plan" | "subagent" | "unknown",
): boolean {
  return normalizeRuntimeMode(runtimeMode) === "approval-required" &&
    (toolCategory === "terminal" || toolCategory === "write");
}
