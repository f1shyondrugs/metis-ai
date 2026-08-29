import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WorkflowStore, runWorkflow } from "./workflow-store.mjs";
import {
  CHILD_CONNECT_TIMEOUT_MS,
  SEARCH_OVERALL_TIMEOUT_MS,
  SEARCH_REMOTE_CONCURRENCY,
  SEARCH_STDIO_CONCURRENCY,
  compactToolMatch,
  mapWithConcurrency,
  rankToolMatches,
  scoreToolHaystack,
  toolSearchHaystack,
  withOverallBudget,
  withTimeout as withChildTimeout,
} from "./tool-search.mjs";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { loadMcpSdk } from "./sdk-runtime.mjs";
import { findSymbol, inspectCodebase, searchRepository } from "../repo-index.mjs";
import { localWebSearch } from "./local-search.mjs";
import { localWebFetch } from "./local-scraper.mjs";
import { verifyTrustedMcpSession } from "./session-token.mjs";
import { normalizeClaims, evaluateClaim, recordVerified, ledgerSummary, compactReport } from "./work-ledger.mjs";

const {
  Client,
  StdioClientTransport,
  StreamableHTTPClientTransport,
  Server,
  StdioServerTransport,
  StreamableHTTPServerTransport,
  isInitializeRequest,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = await loadMcpSdk();

const env = (name, fallback = "") => process.env[name]?.trim() || fallback;
const boolEnv = (name, fallback = false) => {
  const value = env(name).toLowerCase();
  return value ? ["1", "true", "yes", "on"].includes(value) : fallback;
};
const APP_NAME = env("APP_NAME", "Metis AI");
const PORT = Number.parseInt(env("MCP_PORT", "8787"), 10);
const ROOT = env("AI_CHAT_ROOT", process.cwd());
const STATE_DIR = env("AI_CHAT_MCP_STATE_DIR", path.join(ROOT, "data", "mcp-state"));
const PUBLIC_URL = env("MCP_PUBLIC_URL", `http://127.0.0.1:${PORT}`);
const INTERNAL_ORIGIN = env("AI_CHAT_INTERNAL_ORIGIN", env("AI_CHAT_PUBLIC_URL"));
function configuredInternalUrl(name, route) {
  const configured = env(name);
  if (configured) return configured;
  if (!INTERNAL_ORIGIN) {
    throw new Error(`${name} is not configured; set the explicit Metis internal runtime URL`);
  }
  return `${INTERNAL_ORIGIN.replace(/\/+$/, "")}${route}`;
}
const INTERNAL_URL = configuredInternalUrl("AI_CHAT_INTERNAL_URL", "/api/internal/mcp-question");
const INTERNAL_APPROVAL_URL = configuredInternalUrl("AI_CHAT_MCP_APPROVAL_URL", "/api/internal/mcp-approval");
const INTERNAL_WORKSPACE_URL = configuredInternalUrl("AI_CHAT_WORKSPACE_URL", "/api/internal/mcp-workspace");
const INTERNAL_CHAT_URL = configuredInternalUrl("AI_CHAT_CHAT_URL", "/api/internal/mcp-chat");
const INTERNAL_NOTES_URL = configuredInternalUrl("AI_CHAT_NOTES_URL", "/api/internal/mcp-notes");
const INTERNAL_MEMORY_URL = configuredInternalUrl("AI_CHAT_MEMORY_URL", "/api/internal/mcp-memory");
const INTERNAL_BROWSER_URL = configuredInternalUrl("AI_CHAT_BROWSER_URL", "/api/internal/browser");
const INTERNAL_AGENT_STATE_URL = configuredInternalUrl("AI_CHAT_AGENT_STATE_URL", "/api/internal/mcp-agent-state");
const INTERNAL_SUBAGENT_URL = configuredInternalUrl("AI_CHAT_SUBAGENT_URL", "/api/internal/mcp-subagent");
const INTERNAL_REMOTE_CLIENT_URL = configuredInternalUrl("AI_CHAT_REMOTE_CLIENT_URL", "/api/internal/remote-client");
const INTERNAL_AUTOMATION_URL = configuredInternalUrl("AI_CHAT_AUTOMATION_URL", "/api/internal/mcp-automation");
const INTERNAL_FILE_URL = configuredInternalUrl("AI_CHAT_FILE_URL", "/api/internal/mcp-file");

function internalLeaseHeaders(context = {}) {
  return {
    "X-AI-Chat-Worker-Id": String(context.workerId || process.env.AI_CHAT_WORKER_ID || ""),
    "X-AI-Chat-Lease-Token": String(context.leaseToken || process.env.AI_CHAT_JOB_LEASE_TOKEN || ""),
  };
}
const ENABLE_OPTIONAL_MCP = boolEnv("MCP_ENABLE_OPTIONAL_SERVERS");
const ENABLE_REMOTE_MCP = boolEnv("MCP_ENABLE_REMOTE_SERVERS");
const REGISTRY_PATH = path.join(STATE_DIR, "registry.json");
const AUDIT_PATH = path.join(STATE_DIR, "audit.jsonl");
const WORKFLOW_PATH = path.join(STATE_DIR, "workflows.json");
const workflowStore = new WorkflowStore(WORKFLOW_PATH);
const ARTIFACT_DIR = path.join(STATE_DIR, "artifacts");
// ── Error-log core tools ────────────────────────────────────────────────────
// The gateway runs in its own process, so anchor the SQLite DatabaseSync on
// globalThis to avoid opening duplicate handles when modules are re-imported.
const errorLogDbGlobal = globalThis;
async function errorLogDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const key = "__metisErrorLogDb";
  const holder = errorLogDbGlobal;
  if (!holder[key]) {
    holder[key] = new DatabaseSync(path.join(ROOT, "data", "chat.sqlite"), { timeout: 10_000 });
    holder[key].exec(`
      CREATE TABLE IF NOT EXISTS error_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('error', 'warn', 'info')),
        source TEXT NOT NULL CHECK (source IN ('frontend', 'api', 'worker', 'ws', 'telegram', 'browser', 'system')),
        chat_id TEXT,
        user_id TEXT,
        session_label TEXT,
        message TEXT NOT NULL,
        stack TEXT,
        context TEXT
      );
      CREATE INDEX IF NOT EXISTS error_logs_ts ON error_logs(ts);
      CREATE INDEX IF NOT EXISTS error_logs_source ON error_logs(source, ts);
    `);
  }
  return holder[key];
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const CHILD_IDLE_MS = 10 * 60 * 1000;
const PRIVILEGED_TOOLS = new Set([
  "clear_error_logs",
  "execute_command",
  "write_file",
  "docker_ps",
  "service_control",
  "windows_ui",
  "windows_screenshot",
  "windows_desktop_job",
  "electron_test",
]);

const HOSTS = {
  server: {
    os: process.env.MCP_SERVER_OS || "linux",
    mode: "local",
    user: process.env.MCP_SERVER_USER || os.userInfo().username,
    host: "localhost",
    home: process.env.MCP_SERVER_HOME || os.homedir(),
    label: process.env.MCP_SERVER_LABEL || "Local server",
  },
};
if (process.env.MCP_LAPTOP_HOST) {
  HOSTS.laptop = {
    os: "linux",
    mode: "ssh",
    user: process.env.MCP_LAPTOP_USER || os.userInfo().username,
    host: process.env.MCP_LAPTOP_HOST,
    home: process.env.MCP_LAPTOP_HOME || `/home/${process.env.MCP_LAPTOP_USER || os.userInfo().username}`,
    label: process.env.MCP_LAPTOP_LABEL || `Linux laptop (${process.env.MCP_LAPTOP_HOST})`,
  };
}
if (process.env.MCP_PC_HOST) {
  HOSTS.pc = {
    os: "windows",
    mode: "ssh",
    user: process.env.MCP_PC_USER || "User",
    host: process.env.MCP_PC_HOST,
    home: process.env.MCP_PC_HOME || `C:\\Users\\${process.env.MCP_PC_USER || "User"}`,
    label: process.env.MCP_PC_LABEL || `Windows PC (${process.env.MCP_PC_HOST})`,
  };
}

const DEFAULT_REGISTRY = [
  {
    id: "context7",
    name: "Context7 current library documentation",
    kind: "remote",
    url: "https://mcp.context7.com/mcp",
    enabled: ENABLE_REMOTE_MCP,
    tags: ["core", "coding", "docs"],
  },
  {
    id: "exa",
    name: "Exa web search and fetch",
    kind: "remote",
    url: "https://mcp.exa.ai/mcp",
    enabled: ENABLE_REMOTE_MCP,
    tags: ["core", "web", "research"],
  },
  {
    id: "mcp-docs",
    name: "Official Model Context Protocol documentation",
    kind: "remote",
    url: "https://modelcontextprotocol.io/mcp",
    enabled: ENABLE_REMOTE_MCP,
    tags: ["docs", "mcp"],
  },
  {
    id: "github",
    name: "Official GitHub MCP server",
    kind: "stdio",
    command: "bash",
    args: [
      "-lc",
      "token=$(gh auth token 2>/dev/null); exec env GITHUB_PERSONAL_ACCESS_TOKEN=\"$token\" GITHUB_DYNAMIC_TOOLSETS=1 GITHUB_TOOLSETS=\"context,repos,issues,pull_requests,actions,code_security,dependabot,secret_protection\" docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN -e GITHUB_DYNAMIC_TOOLSETS -e GITHUB_TOOLSETS ghcr.io/github/github-mcp-server",
    ],
    enabled: ENABLE_OPTIONAL_MCP,
    tags: ["core", "git", "github", "ci"],
  },
  {
    id: "playwright",
    name: "Microsoft Playwright browser automation",
    kind: "stdio",
    command: "npx",
    args: [
      "-y",
      "@playwright/mcp@latest",
      "--headless",
      "--browser",
      "chromium",
      "--isolated",
      "--output-dir",
      path.join(ARTIFACT_DIR, "playwright"),
    ],
    env: {
      PLAYWRIGHT_BROWSERS_PATH: path.join(os.homedir(), ".cache", "ms-playwright"),
      TMPDIR: path.join(os.homedir(), ".cache", "mcp-tmp"),
    },
    enabled: ENABLE_OPTIONAL_MCP,
    tags: ["browser", "testing", "web", "e2e"],
  },
  {
    id: "chrome-devtools",
    name: "Google Chrome DevTools MCP",
    kind: "stdio",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest", "--headless", "--isolated", "--no-performance-crux", "--no-usage-statistics"],
    enabled: ENABLE_OPTIONAL_MCP,
    tags: ["browser", "debugging", "performance", "lighthouse"],
  },
  {
    id: "filesystem",
    name: "Official sandboxed filesystem server",
    kind: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem@latest", "${MCP_AGENT_CWD}"],
    enabled: ENABLE_OPTIONAL_MCP,
    tags: ["files", "server"],
  },
  {
    id: "memory",
    name: "Official persistent knowledge graph memory",
    kind: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory@latest"],
    env: { MEMORY_FILE_PATH: path.join(STATE_DIR, "memory.jsonl") },
    enabled: ENABLE_OPTIONAL_MCP,
    tags: ["memory", "knowledge"],
  },
  {
    id: "sequential-thinking",
    name: "Official structured planning server",
    kind: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking@latest"],
    enabled: ENABLE_OPTIONAL_MCP,
    tags: ["planning", "reasoning"],
  },
  {
    id: "sentry",
    name: "Sentry debugging and observability",
    kind: "remote",
    url: "https://mcp.sentry.dev/mcp",
    enabled: false,
    tags: ["errors", "observability"],
    note: "Enable after Sentry OAuth or token setup.",
  },
  {
    id: "cloudflare",
    name: "Cloudflare API MCP",
    kind: "remote",
    url: "https://mcp.cloudflare.com/mcp",
    enabled: false,
    tags: ["dns", "workers", "cloud"],
    note: "Enable after Cloudflare authorization is configured.",
  },
  {
    id: "figma",
    name: "Figma design MCP",
    kind: "remote",
    url: "https://mcp.figma.com/mcp",
    enabled: false,
    tags: ["design", "ui"],
    note: "Figma restricts remote clients and requires OAuth.",
  },
  {
    id: "vercel",
    name: "Vercel projects and deployments",
    kind: "remote",
    url: "https://mcp.vercel.com/mcp",
    enabled: false,
    tags: ["deploy", "web"],
    note: "Enable after Vercel authorization is configured.",
  },
];

const childCache = new Map();
const connectingChildren = new Map();
let registryCache = null;
let registryMtime = 0;

const executionContext = new AsyncLocalStorage();
const HOST_ONLY_MCP_IDS = new Set(["github", "filesystem"]);
const LOCAL_FILE_TOOLS = new Set(["execute_command", "list_directory", "read_file", "write_file", "edit_file", "delete_file"]);

function isInsideWorkspace(root, candidate) {
  if (!root?.trim()) return false;
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.isAbsolute(String(candidate || ""))
    ? path.resolve(String(candidate))
    : path.resolve(resolvedRoot, String(candidate || "."));
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRootWorkspace(workspace, home = "/root") {
  const root = path.resolve(home || "/root");
  const candidate = path.resolve(workspace || "");
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolveExecutionIdentity(context = {}) {
  const uid = Number(context.uid ?? process.env.MCP_OS_UID);
  const gid = Number(context.gid ?? process.env.MCP_OS_GID);
  const username = String(context.osUsername || context.username || process.env.MCP_OS_USERNAME || "").trim();
  const workspace = String(context.workspaceRoot || process.env.MCP_AGENT_CWD || "").trim();
  const home = String(context.home || process.env.HOME || "").trim();
  const allowRoot = context.allowRoot === true || process.env.MCP_ALLOW_ROOT_AGENTS === "1";
  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid)) return null;
  if (uid === 0 && (!allowRoot || !isRootWorkspace(workspace, home))) return null;
  return { uid, gid, username, workspace, home };
}

function currentExecution() {
  return executionContext.getStore() || { identity: resolveExecutionIdentity(), context: {} };
}

function currentIdentity() {
  return currentExecution().identity || resolveExecutionIdentity();
}

function currentWorkspace() {
  return currentIdentity()?.workspace || process.env.MCP_AGENT_CWD?.trim() || "";
}

function isHostAdminContext(context = {}) {
  return context.isHostAdmin === true || process.env.MCP_IS_HOST_ADMIN === "1";
}

function q(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

function psq(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function psEncoded(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}

function clampTimeout(value, max = 3600) {
  const n = Number(value || 60);
  return Math.max(1, Math.min(Number.isFinite(n) ? n : 60, max));
}

function targetInfo(target = "server") {
  const t = HOSTS[target || "server"];
  if (!t) throw new Error(`Unknown target ${target}. Use server, laptop, or pc.`);
  return t;
}

function cleanOutput(text) {
  const s = String(text ?? "");
  if (Buffer.byteLength(s, "utf8") <= MAX_OUTPUT_BYTES) return s;
  return s.slice(0, MAX_OUTPUT_BYTES) + "\n...[truncated]";
}

async function readInternalJson(response, label) {
  const body = await response.text();
  const contentType = String(response.headers.get("content-type") || "");
  const html = /^text\/html\b/i.test(contentType) || /^\s*<!doctype html/i.test(body);
  if (!response.ok) {
    throw new Error(`${label} endpoint failed (HTTP ${response.status}): ${body.slice(0, 500)}`);
  }
  if (html) {
    throw new Error(`${label} endpoint returned HTML instead of JSON (HTTP ${response.status}); check its explicit runtime URL`);
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error(`${label} endpoint returned invalid JSON (HTTP ${response.status})`);
  }
}

// Keep authorization metadata separate from tool names. A name-based fallback
// makes a newly added or child-MCP tool inherit a permission accidentally.
// Unknown tools are therefore denied whenever a run has a capability manifest
// unless the manifest grants that exact tool explicitly.
const TOOL_CATEGORIES = new Map([
  ["provide_file", "write"],
  ["create_automation", "write"],
  ["list_automations", "read"],
  ["update_automation", "write"],
  ["run_automation", "write"],
  ["pause_automation", "write"],
  ["resume_automation", "write"],
  ["delete_automation", "write"],
  ["write_todos", "plan"],
  ["create_plan", "plan"],
  ["create_canvas", "plan"],
  ["edit_plan", "plan"],
  ["edit_canvas", "plan"],
  ["update_chat_title", "write"],
  ["update_chat_keywords", "write"],
  ["search_chats", "read"],
  ["context_search", "read"],
  ["context_profile", "read"],
  ["context_remember", "memory"],
  ["list_notes", "read"],
  ["search_notes", "read"],
  ["create_note", "memory"],
  ["update_note", "memory"],
  ["list_memories", "read"],
  ["add_memory", "memory"],
  ["edit_memory", "memory"],
  ["delete_memory", "memory"],
  ["list_workspaces", "read"],
  ["delete_plan", "plan"],
  ["delete_canvas", "plan"],
  ["git_status", "read"],
  ["git_diff", "read"],
  ["browser_extract_text", "browser"],
  ["browser_form_state", "browser"],
  ["browser_batch", "browser"],
  ["browser_wait_for", "browser"],
  ["browser_fill_form", "browser"],
  ["browser_download", "browser"],
  ["browser_drag", "browser"],
  ["browser_hover", "browser"],
  ["browser_select_option", "browser"],
  ["browser_upload_file", "browser"],
  ["gateway_status", "read"],
  ["list_mcp_servers", "read"],
  ["search_tools", "read"],
  ["list_server_tools", "read"],
  ["call_mcp_tool", "read"],
  ["ask_user", "read"],
  ["request_mode_change", "read"],
  ["wait", "read"],
  ["delegate_subagent", "subagent"],
  ["subagent_status", "read"],
  ["ensure_capability", "write"],
  ["sync_agent_knowledge", "write"],
  ["upsert_mcp_server", "write"],
  ["set_mcp_server_enabled", "write"],
  ["web_search", "read"],
  ["web_fetch", "read"],
  ["browser_navigate", "browser"],
  ["browser_snapshot", "browser"],
  ["browser_screenshot", "browser"],
  ["browser_click", "browser"],
  ["browser_type", "browser"],
  ["browser_press", "browser"],
  ["browser_resize", "browser"],
  ["browser_scroll", "browser"],
  ["browser_tabs", "browser"],
  ["context7_resolve", "read"],
  ["context7_query", "read"],
  ["system_info", "read"],
  ["execute_command", "terminal"],
  ["remote_client_terminal", "remote"],
  ["list_remote_clients", "remote"],
  ["list_directory", "read"],
  ["read_file", "read"],
  ["repo_search", "read"],
  ["inspect_codebase", "read"],
  ["find_symbol", "read"],
  ["write_file", "write"],
  ["edit_file", "write"],
  ["delete_file", "write"],
  ["docker_ps", "terminal"],
  ["service_control", "terminal"],
  ["windows_ui", "remote"],
  ["windows_screenshot", "remote"],
  ["electron_test", "remote"],
  ["windows_desktop_job", "remote"],
  ["workflow_save", "write"],
  ["workflow_list", "read"],
  ["workflow_get", "read"],
  ["workflow_delete", "write"],
  ["workflow_run", "write"],
  ["assistant_status", "read"],
  ["gateway_bootstrap", "write"],
  ["search_registry", "read"],
  ["registry_status", "read"],
  ["registry_changes", "read"],
  ["provision_registry_server", "write"],
  ["test_mcp_server", "read"],
  ["sync_project_rules", "write"],
  ["get_catalog_version", "read"],
  ["get_catalog_changes", "read"],
  ["list_recent_errors", "read"],
  ["read_error_log_detail", "read"],
  ["clear_error_logs", "write"],
  ["get_connection_instructions", "read"],
  ["verify_work", "terminal"],
  ["ledger_review", "read"],
  ["audio_fingerprint", "read"],
]);

function modeToolCategory(name) {
  return TOOL_CATEGORIES.get(String(name).toLowerCase()) || "unknown";
}

function runtimeModeRequiresApproval(runtimeMode, toolCategory) {
  return String(runtimeMode || process.env.AI_CHAT_RUNTIME_MODE || "").trim() === "approval-required" &&
    (toolCategory === "terminal" || toolCategory === "write");
}

function runtimeApprovalRequiredForTool(name, context = {}) {
  const runtimeMode = String(context.runtimeMode || process.env.AI_CHAT_RUNTIME_MODE || "").trim();
  const required = runtimeModeRequiresApproval(runtimeMode, modeToolCategory(name));
  if (required && context.automation) {
    throw new Error(`${name} requires interactive approval and is unavailable during an automation run.`);
  }
  return required;
}

function approvalPatternFor(toolName, input) {
  const name = String(toolName || "").trim();
  const rawInput = String(typeof input === "string" ? input : JSON.stringify(input ?? {})).trim();
  return `${name}:${rawInput}`.slice(0, 2000);
}

function shouldAutoApprove(patterns, toolName, input) {
  if (!Array.isArray(patterns) || !patterns.length) return false;
  const target = approvalPatternFor(toolName, input);
  return patterns.some((pattern) => target.startsWith(String(pattern || "").trim().slice(0, 2000)));
}

function asApprovalError(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

async function postRuntimeApproval(token, payload, headers) {
  const response = await fetch(INTERNAL_APPROVAL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function resolveExpiredApproval(token, approvalId, headers, reason) {
  try {
    await postRuntimeApproval(token, { action: "expire", approvalId, reason }, headers);
  } catch {
    // The periodic store expiry remains the durable fallback.
  }
}

async function ensureRuntimeApproval(name, args, context = {}) {
  if (!runtimeApprovalRequiredForTool(name, context)) return;
  const chatId = String(context.chatId || "").trim();
  const jobId = String(context.jobId || "").trim();
  if (!chatId || !jobId) throw new Error(`${name} requires a session context before runtime approval`);
  const token = String(process.env.MCP_BEARER_TOKEN || "").trim();
  const headers = {
    "X-AI-Chat-Id": chatId,
    "X-AI-Chat-User-Id": String(context.userId || ""),
    "X-AI-Chat-Job-Id": jobId,
    ...internalLeaseHeaders(context),
  };
  const sessionScope = approvalPatternFor(name, args);

  // The internal endpoint returns the chat's durable session allowlist. This
  // avoids a second HTTP gateway process silently missing an earlier decision.
  const status = await fetch(`${INTERNAL_APPROVAL_URL}?chatId=${encodeURIComponent(chatId)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-AI-Chat-User-Id": String(context.userId || ""),
      "X-AI-Chat-Job-Id": jobId,
      "X-AI-Chat-Lease-Token": headers["X-AI-Chat-Lease-Token"],
      "X-AI-Chat-Worker-Id": headers["X-AI-Chat-Worker-Id"],
    },
    signal: AbortSignal.timeout(15_000),
  });
  const statusBody = await status.json().catch(() => ({}));
  if (!status.ok) throw new Error(`Runtime approval session lookup failed (HTTP ${status.status})`);
  if (shouldAutoApprove(Array.isArray(statusBody.approvedPatterns) ? statusBody.approvedPatterns : [], name, args)) return;

  const { response: created, body: createdBody } = await postRuntimeApproval(token, {
    action: "create",
    jobId,
    chatId,
    title: name === "execute_command" ? "Command approval required" : `${name} approval required`,
    toolName: name,
    args,
    command: typeof args.command === "string" && args.command.trim()
      ? args.command
      : JSON.stringify(args ?? {}),
    ...(typeof args.path === "string" && args.path.trim() ? { files: [{ path: args.path, status: "pending" }] } : {}),
    sessionScope,
  }, headers);
  const approvalId = String(createdBody.approvalId || "");
  if (!created.ok || !approvalId) {
    throw new Error(`Runtime approval endpoint failed (HTTP ${created.status})`);
  }

  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const poll = await fetch(`${INTERNAL_APPROVAL_URL}?id=${encodeURIComponent(approvalId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-AI-Chat-Id": chatId,
        "X-AI-Chat-User-Id": String(context.userId || ""),
        "X-AI-Chat-Job-Id": jobId,
      },
      signal: AbortSignal.timeout(15_000),
    });
    const pollBody = await poll.json().catch(() => ({}));
    if (!poll.ok) throw new Error(`Runtime approval status failed (HTTP ${poll.status})`);
    if (pollBody.status === "resolved") {
      if (pollBody.decision === "deny") throw new Error("User denied this action");
      if (pollBody.decision === "allow" || pollBody.decision === "allow-session") return;
    }
    if (Date.now() >= deadline) {
      await resolveExpiredApproval(token, approvalId, headers, "Runtime approval timed out.");
      throw new Error("Runtime approval timed out after 10 minutes.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function capabilityHash(manifest) {
  return createHash("sha256").update(JSON.stringify(stableValue(manifest))).digest("hex");
}

function readCapabilityManifest(context = {}) {
  const raw = context.capabilityManifest || process.env.MCP_CAPABILITY_MANIFEST;
  if (!raw) return null;
  let manifest;
  try { manifest = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { throw new Error("Invalid capability manifest"); }
  if (!manifest || manifest.version !== 1 || typeof manifest.ownerId !== "string" ||
      typeof manifest.workspaceId !== "string" || typeof manifest.runId !== "string" ||
      typeof manifest.attemptId !== "string" || typeof manifest.policyVersion !== "string" ||
      !Array.isArray(manifest.allowedCategories) || !manifest.toolOverrides ||
      typeof manifest.toolOverrides !== "object" ||
      !manifest.childMcpGrants || typeof manifest.childMcpGrants !== "object" ||
      Array.isArray(manifest.childMcpGrants)) {
    throw new Error("Malformed capability manifest");
  }
  const validCategories = new Set(["read", "write", "terminal", "browser", "memory", "remote", "plan", "subagent"]);
  if (manifest.allowedCategories.some((category) => !validCategories.has(category))) {
    throw new Error("Malformed capability manifest categories");
  }
  if (Object.entries(manifest.toolOverrides).some(([name, allowed]) => !name.trim() || typeof allowed !== "boolean")) {
    throw new Error("Malformed capability manifest overrides");
  }
  if (manifest.childMcpGrants && Object.entries(manifest.childMcpGrants).some(([server, grantedTools]) =>
    !server.trim() || !Array.isArray(grantedTools) ||
    grantedTools.some((tool) => typeof tool !== "string" || !tool.trim()))) {
    throw new Error("Malformed child MCP grants");
  }
  const expectedHash = String(context.capabilityHash || process.env.MCP_CAPABILITY_HASH || "");
  if (!expectedHash || expectedHash !== capabilityHash(manifest)) {
    throw new Error("Capability manifest hash mismatch");
  }
  if (context.userId && manifest.ownerId !== context.userId) throw new Error("Capability manifest owner mismatch");
  if (context.jobId && manifest.runId !== context.jobId) throw new Error("Capability manifest run mismatch");
  return manifest;
}

function childCacheKey(serverId, context = {}) {
  return `${String(context.userId || "anonymous")}:${serverId}`;
}

function childMcpAllows(serverId, toolName, context = {}) {
  const manifest = readCapabilityManifest(context);
  if (!manifest) return true;
  const grants = manifest.childMcpGrants[serverId] || manifest.childMcpGrants["*"];
  return Array.isArray(grants) &&
    (toolName === "*" ? grants.length > 0 : grants.includes("*") || grants.includes(toolName));
}

function assertChildMcpGrant(serverId, toolName, context = {}) {
  if (!childMcpAllows(serverId, toolName, context)) {
    throw new Error(`Child MCP capability ${serverId}/${toolName} is not granted by the run capability manifest.`);
  }
}

function capabilityAllowsTool(name, context = {}) {
  const manifest = readCapabilityManifest(context);
  if (!manifest) return true;
  if (Object.prototype.hasOwnProperty.call(manifest.toolOverrides, name)) {
    return manifest.toolOverrides[name] === true;
  }
  const category = modeToolCategory(name);
  return category !== "unknown" && manifest.allowedCategories.includes(category);
}

function assertCapabilityPolicy(name, context = {}) {
  if (!capabilityAllowsTool(name, context)) {
    throw new Error(`Tool ${name} is not granted by the run capability manifest.`);
  }
}

function assertModePolicy(name, context = {}) {
  if (!context.modePolicy) return;
  let policy;
  try { policy = JSON.parse(String(context.modePolicy)); } catch { throw new Error("Invalid agent mode policy"); }
  if (policy?.toolOverrides && Object.prototype.hasOwnProperty.call(policy.toolOverrides, name)) {
    if (policy.toolOverrides[name] !== true) throw new Error(`Tool ${name} is not allowed in mode ${context.modeId || "custom"}.`);
    return;
  }
  const category = modeToolCategory(name);
  if (!Array.isArray(policy?.allowedCategories) || !policy.allowedCategories.includes(category)) {
    throw new Error(`Tool ${name} (${category}) is not allowed in mode ${context.modeId || "custom"}.`);
  }
}

function modeAllowsBrowser(context = {}) {
  if (!context.modePolicy) return false;
  try {
    const policy = JSON.parse(String(context.modePolicy));
    return Array.isArray(policy?.allowedCategories) && policy.allowedCategories.includes("browser");
  } catch {
    return false;
  }
}

const EXTERNAL_BROWSER_AUTOMATION_RE = /(?:\bplaywright\b|\bpuppeteer\b|\bselenium\b|\bwebdriver\b|chromium\s*\.\s*(?:launch|connect)|launchPersistentContext|connectOverCDP|chrome-headless-shell)/i;

async function assertSharedBrowserCommand(args = {}, context = {}) {
  if (!context.chatId || !modeAllowsBrowser(context)) return;
  const target = String(args.target || "server").toLowerCase();
  if (target !== "server" && target !== "local") return;
  const command = String(args.command || "");
  let probe = command;
  // Agents sometimes hide Playwright in a temporary script and then run `node file.cjs`.
  // Inspect small local JS/TS entrypoints referenced by the command as well.
  const scriptMatches = [...command.matchAll(/(?:^|[;&|\s])(?:node|tsx|bun)\s+(?:--?[^\s]+\s+)*([^\s;&|]+\.(?:[cm]?js|ts))(?=\s|$|[;&|])/gi)];
  for (const match of scriptMatches.slice(0, 4)) {
    try {
      const raw = String(match[1] || "").replace(/^['"]|['"]$/g, "");
      const resolved = path.isAbsolute(raw) ? raw : path.resolve(String(args.cwd || currentWorkspace() || ROOT), raw);
      const stat = await fs.stat(resolved);
      if (!stat.isFile() || stat.size > 256 * 1024) continue;
      probe += `\n${await fs.readFile(resolved, "utf8")}`;
    } catch {
      // Missing/unreadable script: normal shell execution will report it later.
    }
  }
  if (EXTERNAL_BROWSER_AUTOMATION_RE.test(probe)) {
    throw new Error(
      "Detached Playwright/Puppeteer/Selenium/Chromium automation is disabled for chat browser tasks because it bypasses the shared Metis browser and sidebar. Use browser_form_state, browser_batch, browser_wait_for, and the other browser_* tools so the user can follow the same session live.",
    );
  }
}

function assertToolPolicy(name, context = {}, args = {}) {
  assertCapabilityPolicy(name, context);
  assertModePolicy(name, context);
  if (context.automation && new Set([
    "ask_user",
    "request_confirmation",
    "request_mode_change",
    "wait",
    "subagent_status",
  ]).has(name)) {
    throw new Error(`${name} is unavailable during an automation run because no user interaction is possible.`);
  }
  if (context.incognito && new Set([
    "list_memories", "add_memory", "edit_memory", "delete_memory",
    "context_search", "context_profile", "context_remember",
    "list_notes", "search_notes", "create_note", "update_note",
    "list_workspaces", "create_plan", "edit_plan", "delete_plan",
    "create_canvas", "edit_canvas", "delete_canvas",
    "update_chat_keywords", "search_chats",
  ]).has(name)) {
    throw new Error(`${name} is unavailable in Incognito.`);
  }
  if (
    PRIVILEGED_TOOLS.has(name) &&
    context.transport === "http" &&
    context.trustedInternal !== true &&
    !String(args.target || "").startsWith("client:") &&
    process.env.MCP_ALLOW_REMOTE_ADMIN !== "true"
  ) {
    throw new Error(
      `${name} is disabled for remote MCP clients. Set MCP_ALLOW_REMOTE_ADMIN=true only in a trusted deployment.`,
    );
  }
}

function runSpawn(cmd, args, timeoutSec, input = "", cwd = undefined, env = undefined) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const identity = currentIdentity();
    const spawnEnv = { ...(env || process.env) };
    if (identity?.home) spawnEnv.HOME = identity.home;
    const spawnOpts = {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: spawnEnv,
    };
    if (process.getuid?.() === 0 && identity?.uid > 0) {
      spawnOpts.uid = identity.uid;
      spawnOpts.gid = identity.gid;
    }
    const child = spawn(cmd, args, spawnOpts);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    }, timeoutSec * 1000);
    const collect = (buf, which) => {
      const s = buf.toString();
      const current = Buffer.byteLength(stdout + stderr, "utf8");
      if (current >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const left = MAX_OUTPUT_BYTES - current;
      const part = Buffer.from(s).subarray(0, left).toString();
      if (part.length < s.length) truncated = true;
      if (which === "stdout") stdout += part;
      else stderr += part;
    };
    child.stdout.on("data", (d) => collect(d, "stdout"));
    child.stderr.on("data", (d) => collect(d, "stderr"));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + err.message, exit_code: -1, duration_ms: Date.now() - started, truncated });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exit_code: code ?? -1, signal, duration_ms: Date.now() - started, truncated });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

async function runWindowsPowerShell(script, timeout = 60) {
  return runSpawn(
    "ssh",
    [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=8",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=2",
      `${HOSTS.pc.user}@${HOSTS.pc.host}`,
      "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", psEncoded(script),
    ],
    clampTimeout(timeout, 3600) + 15,
  );
}

async function runShell({ target = "server", command, timeout = 60, cwd, sudo = false }) {
  const t = targetInfo(target);
  const timeoutSec = clampTimeout(timeout, 3600);
  if (!command || typeof command !== "string") throw new Error("command is required");
  if (t.os === "windows") {
    const dir = cwd || t.home;
    const script = `$ErrorActionPreference='Continue'; Set-Location -LiteralPath ${psq(dir)}; ${command}`;
    return runWindowsPowerShell(script, timeoutSec);
  }
  const identity = currentIdentity();
  const workspace = currentWorkspace();
  const workingDir =
    cwd ||
    (target === "server" ? workspace : "") ||
    t.home;
  if (target === "server" && workspace && !isInsideWorkspace(workspace, workingDir)) {
    throw new Error("Path must be inside the agent workspace.");
  }
  if (target === "server" && process.getuid?.() === 0 && !identity) {
    throw new Error("Local shell tools require a non-root OS user mapping.");
  }
  const inner = `cd ${q(workingDir)} && ${command}`;
  const allowSudo = sudo && !(identity && identity.uid > 0);
  const finalCmd = allowSudo ? `sudo -n bash -lc ${q(inner)}` : inner;
  if (t.mode === "local") return runSpawn("bash", ["-lc", finalCmd], timeoutSec);
  return runSpawn(
    "ssh",
    [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=8",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=2",
      `${t.user}@${t.host}`,
      finalCmd,
    ],
    timeoutSec + 15,
  );
}

async function runWindowsJob(job, waitSeconds = undefined) {
  const id = `job-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const payload = Buffer.from(JSON.stringify(job), "utf8").toString("base64");
  const pcHome = HOSTS.pc.home;
  const base = `${pcHome}\\.metis-ai-mcp-runner`;
  const jobPath = `${base}\\jobs\\${id}.json`;
  const resultPath = `${base}\\results\\${id}.json`;
  const write = await runWindowsPowerShell(
    `[IO.File]::WriteAllBytes(${psq(jobPath)},[Convert]::FromBase64String(${psq(payload)})); 'QUEUED'`,
    30,
  );
  if (write.exit_code !== 0) throw new Error(`Unable to queue Windows desktop job: ${write.stderr || write.stdout}`);
  const wait = clampTimeout(waitSeconds || (Number(job.timeout || 600) + 30), 3700);
  const poll = await runWindowsPowerShell(
    `$deadline=(Get-Date).AddSeconds(${wait}); while((Get-Date)-lt $deadline -and -not (Test-Path -LiteralPath ${psq(resultPath)})){Start-Sleep -Milliseconds 350}; if(Test-Path -LiteralPath ${psq(resultPath)}){Get-Content -Raw -LiteralPath ${psq(resultPath)}; Remove-Item -Force -LiteralPath ${psq(resultPath)}}else{Write-Error 'Desktop runner timeout'; exit 124}`,
    wait + 10,
  );
  if (poll.exit_code !== 0) throw new Error(`Windows desktop job failed to return: ${poll.stderr || poll.stdout}`);
  try {
    return JSON.parse(poll.stdout.trim());
  } catch {
    return { ok: false, error: "Invalid runner response", raw: poll.stdout, stderr: poll.stderr };
  }
}

async function ensureState() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  try {
    await fs.access(REGISTRY_PATH);
  } catch {
    await fs.writeFile(REGISTRY_PATH, JSON.stringify({ version: 1, servers: DEFAULT_REGISTRY }, null, 2) + "\n", { mode: 0o600 });
    return;
  }
  const parsed = JSON.parse(await fs.readFile(REGISTRY_PATH, "utf8"));
  const servers = Array.isArray(parsed) ? parsed : parsed.servers || [];
  const existingIds = new Set(servers.map((server) => server.id));
  const missingDefaults = DEFAULT_REGISTRY.filter((server) => !existingIds.has(server.id));
  if (missingDefaults.length) {
    await fs.writeFile(
      REGISTRY_PATH,
      JSON.stringify({ version: 1, servers: [...servers, ...missingDefaults] }, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
}

async function loadRegistry(force = false) {
  await ensureState();
  const stat = await fs.stat(REGISTRY_PATH);
  if (!force && registryCache && stat.mtimeMs === registryMtime) return registryCache;
  const parsed = JSON.parse(await fs.readFile(REGISTRY_PATH, "utf8"));
  registryCache = Array.isArray(parsed) ? parsed : parsed.servers || [];
  registryMtime = stat.mtimeMs;
  return registryCache;
}

function visibleRegistry(registry, context = {}) {
  let servers = context.userId
    ? registry.filter((entry) => !entry.ownerId || entry.ownerId === context.userId)
    : registry;
  if (context.userId && !isHostAdminContext(context)) {
    servers = servers.filter((entry) => !HOST_ONLY_MCP_IDS.has(entry.id) || entry.ownerId === context.userId);
  }
  return servers;
}

async function saveRegistry(servers) {
  await fs.writeFile(REGISTRY_PATH, JSON.stringify({ version: 1, servers }, null, 2) + "\n", { mode: 0o600 });
  registryCache = servers;
  registryMtime = (await fs.stat(REGISTRY_PATH)).mtimeMs;
}

export async function removeMcpServer(id, context = {}) {
  const registry = await loadRegistry();
  if (context.userId && !registry.some((entry) => entry.id === id && entry.ownerId === context.userId)) return false;
  const next = registry.filter((entry) => entry.id !== id);
  if (next.length === registry.length) return false;
  await closeChild(id);
  await saveRegistry(next);
  return true;
}

function expandEnv(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => process.env[key] || "");
}

function resolvedEnv(entry) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(entry.env || {})) env[key] = expandEnv(String(value));
  return env;
}

async function closeChild(id) {
  const keys = [...childCache.keys()].filter((key) => key.endsWith(`:${id}`));
  await Promise.all(keys.map(async (key) => {
    const cached = childCache.get(key);
    if (!cached) return;
    childCache.delete(key);
    try { await cached.client.close(); } catch {}
    try { await cached.transport.close(); } catch {}
  }));
}

async function connectChild(entry, serverId, cacheKey) {
  const client = new Client({ name: "mcp-gateway", version: "4.0.0" }, { capabilities: {} });
  let transport;
  try {
    if (entry.kind === "remote") {
      const headers = {};
      for (const [key, value] of Object.entries(entry.headers || {})) headers[key] = expandEnv(String(value));
      transport = new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers } });
    } else if (entry.kind === "stdio") {
      transport = new StdioClientTransport({
        command: entry.command,
        args: (entry.args || []).map(expandEnv),
        env: resolvedEnv(entry),
        cwd: entry.cwd || ROOT,
        stderr: "pipe",
      });
      if (transport.stderr) transport.stderr.on("data", (d) => console.error(`[child:${serverId}] ${d.toString().trimEnd()}`));
    } else {
      throw new Error(`Unsupported child MCP kind: ${entry.kind}`);
    }
    await withChildTimeout(
      client.connect(transport),
      CHILD_CONNECT_TIMEOUT_MS,
      `Timed out connecting to MCP server ${serverId}`,
    );
    const item = { entry, client, transport, lastUsed: Date.now(), tools: null, toolsAt: 0 };
    childCache.set(cacheKey, item);
    return item;
  } catch (error) {
    try { await client.close(); } catch {}
    try { if (transport) await transport.close(); } catch {}
    throw error;
  }
}

async function getChild(serverId, context = {}) {
  if (!childMcpAllows(serverId, "*", context)) {
    throw new Error(`Child MCP server ${serverId} is not granted by the run capability manifest.`);
  }
  const registry = visibleRegistry(await loadRegistry(), context);
  const entry = registry.find((s) => s.id === serverId);
  if (!entry) throw new Error(`Unknown MCP server: ${serverId}`);
  if (!entry.enabled) throw new Error(`MCP server ${serverId} is disabled. ${entry.note || ""}`.trim());
  const cacheKey = childCacheKey(serverId, context);
  const cached = childCache.get(cacheKey);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached;
  }
  const inflight = connectingChildren.get(cacheKey);
  if (inflight) return inflight;
  const pending = connectChild(entry, serverId, cacheKey).finally(() => connectingChildren.delete(cacheKey));
  connectingChildren.set(cacheKey, pending);
  return pending;
}

async function childTools(serverId, force = false, context = {}) {
  const child = await getChild(serverId, context);
  if (!force && child.tools && Date.now() - child.toolsAt < 5 * 60 * 1000) return child.tools;
  const response = await withChildTimeout(
    child.client.listTools(),
    CHILD_CONNECT_TIMEOUT_MS,
    `Timed out listing tools from MCP server ${serverId}`,
  );
  child.tools = response.tools || [];
  child.toolsAt = Date.now();
  return child.tools.filter((tool) => childMcpAllows(serverId, tool.name, context));
}

async function collectServerToolMatches(entry, query, context) {
  const serverTools = await childTools(entry.id, false, context);
  const matches = [];
  for (const tool of serverTools) {
    const score = scoreToolHaystack(query, toolSearchHaystack(entry, tool));
    if (score > 0) matches.push(compactToolMatch(entry, tool, score));
  }
  return matches;
}

async function searchEnabledChildTools(registry, query, limit, context) {
  const remotes = registry.filter((entry) => entry.kind === "remote");
  const stdio = registry.filter((entry) => entry.kind !== "remote");
  const found = [];
  const errors = [];
  const scan = async (entries, concurrency) => {
    const rows = await mapWithConcurrency(entries, concurrency, async (entry) => {
      try {
        return { matches: await collectServerToolMatches(entry, query, context), error: null };
      } catch (err) {
        return { matches: [], error: { server: entry.id, error: err.message } };
      }
    });
    for (const row of rows) {
      found.push(...row.matches);
      if (row.error) errors.push(row.error);
    }
  };
  await withOverallBudget(
    (async () => {
      await scan(remotes, SEARCH_REMOTE_CONCURRENCY);
      await scan(stdio, SEARCH_STDIO_CONCURRENCY);
      return true;
    })(),
    SEARCH_OVERALL_TIMEOUT_MS,
    () => {
      errors.push({ server: "*", error: "search_budget_exceeded" });
      return false;
    },
  );
  return { tools: rankToolMatches(found, limit), errors };
}

async function callChild(serverId, toolName, args = {}, context = {}) {
  assertChildMcpGrant(serverId, toolName, context);
  const child = await getChild(serverId, context);
  child.lastUsed = Date.now();
  return child.client.callTool({ name: toolName, arguments: args || {} });
}

setInterval(async () => {
  const now = Date.now();
  for (const [id, child] of childCache.entries()) {
    if (now - child.lastUsed > CHILD_IDLE_MS) await closeChild(id);
  }
}, 60_000).unref();

async function audit(tool, args, outcome = "called") {
  try {
    const clean = JSON.parse(JSON.stringify(args || {}));
    if (clean.content) clean.content = `[redacted ${String(clean.content).length} chars]`;
    if (clean.token) clean.token = "[redacted]";
    await fs.appendFile(AUDIT_PATH, JSON.stringify({ at: new Date().toISOString(), tool, outcome, args: clean }) + "\n", "utf8");
  } catch {}
}

function asText(data) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] };
}

function returnChildResult(result) {
  if (!result || !Array.isArray(result.content)) return asText(result);
  return result;
}

function childResultText(result) {
  return (result?.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function childResultJson(result) {
  const text = childResultText(result);
  try { return JSON.parse(text); }
  catch { throw new Error(`Child MCP did not return JSON: ${text.slice(0, 1000)}`); }
}

const targetProp = {
  type: "string",
  default: "server",
  description: `Available targets: ${Object.keys(HOSTS).join(", ")} or client:<remote-client-id>.`,
};

const tools = [
  {
    name: "provide_file",
    description: "Attach a file to the current chat and make it available as a protected download link and preview. Whenever the user asks to attach, send, share, export, or provide a file, you MUST call provide_file; creating the file or mentioning its path is not enough. Call once for each file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path of the file to attach. This must be an existing file." },
        name: { type: "string", description: "Optional display name for the download." },
        mimeType: { type: "string", description: "Optional MIME type when the file extension is ambiguous." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "create_automation",
    description: "Create a one-time or recurring autonomous agent automation. Every run gets its own persistent chat transcript and can use the same allowed tools, child MCPs, remote tools, and persistent Metis browser as a normal Agent-mode run. Recurring schedules can use minutes, days, or a calendar day each month. After a successful create, include a Markdown link [name](automation://<id>) using the id from the result. Do not claim creation without a completed tool call.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        prompt: { type: "string" },
        chatId: { type: "string" },
        modeId: { type: "string", description: "Agent mode to use for each run." },
        modelId: { type: "string", description: "Primary model to use for each run." },
        extendedModelId: { type: "string", description: "Model used for delegated/extended agent work." },
        maxRunMinutes: { type: "integer", minimum: 5, maximum: 10080, description: "Maximum duration of one run in minutes. Defaults to 1440 (24 hours); use up to 10080 (7 days) for very long tasks." },
        timezone: { type: "string" },
        schedule: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["once", "interval", "days", "monthly"] },
            at: { type: "string", description: "ISO timestamp for a one-time run." },
            everyMinutes: { type: "integer", minimum: 60, description: "Recurring interval in minutes." },
            everyDays: { type: "integer", minimum: 1, description: "Recurring interval in days." },
            dayOfMonth: { type: "integer", minimum: 1, maximum: 31, description: "Calendar day for monthly runs. Day 31 runs on the last day in shorter months." },
          },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      required: ["name", "prompt", "schedule"],
      additionalProperties: false,
    },
  },
  {
    name: "list_automations",
    description: "List the current user's automations, including creator, node graph, isolated persistent run chats, status, and recent runs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "update_automation",
    description: "Update an existing automation's name, prompt, context chat, models, maximum run duration, timezone, or schedule.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        prompt: { type: "string" },
        chatId: { type: "string" },
        modeId: { type: "string" },
        modelId: { type: "string" },
        extendedModelId: { type: "string" },
        maxRunMinutes: { type: "integer", minimum: 5, maximum: 10080 },
        timezone: { type: "string" },
        schedule: { type: "object" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "run_automation",
    description: "Start an automation immediately as a manual run. The run is isolated in its own persistent chat and does not replace the recurring schedule.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "pause_automation",
    description: "Pause an automation so it will not run until resumed.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "resume_automation",
    description: "Resume a paused automation.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "delete_automation",
    description: "Permanently delete an automation and its run history.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "write_todos",
    description: "Create or replace a short in-chat checklist. Use only for work with 3+ distinct steps; skip it for a single edit. It appears in the message, not as a side-panel plan. Use create_plan only when the user asked for a plan document.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
  },
  {
    name: "create_plan",
    description: "Create or replace a real Metis plan workspace in the current chat. Provide the complete plan content; a title alone is not sufficient.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", default: "Plan" },
        content: { type: "string", minLength: 1 },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "create_canvas",
    description: "Create or replace a real Metis canvas workspace in the current chat. Provide the complete canvas content; a title alone is not sufficient.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", default: "Canvas" },
        content: { type: "string", minLength: 1 },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_plan",
    description: "Edit an existing plan workspace in the current chat.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_canvas",
    description: "Edit an existing canvas workspace in the current chat.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_chat_title",
    description: "Set the current chat title.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "update_chat_keywords",
    description: "Add concise, non-sensitive keywords to the current chat so it can be found later. Use this silently when the topic becomes clear or changes.",
    inputSchema: {
      type: "object",
      properties: {
        keywords: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 12,
        },
        mode: { type: "string", enum: ["add", "replace"], default: "add" },
      },
      required: ["keywords"],
      additionalProperties: false,
    },
  },
  {
    name: "search_chats",
    description: "Search the signed-in user's chats by title, keywords, or message content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 30, default: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "context_search",
    description: "Search the owner's personal context hub: devices, servers, services, projects, preferences, and long-term facts. Use before answering questions about the user's setup, before planning changes to their infrastructure, or when background knowledge about the owner would change the answer. Returns grounded context only, never secrets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up, e.g. 'server services' or 'Windows PC'." },
        project_name: { type: "string" },
        max_chars: { type: "integer", default: 4000, description: "Response budget in characters (500-12000)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "context_profile",
    description: "Read the owner's canonical profile: identity, core preferences, infrastructure overview, and active projects. Cheaper than context_search when a general overview is enough.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "context_remember",
    description: "Store one durable, non-secret fact about the owner in the shared context hub (same fact_id updates the fact). Never store passwords, API keys, cookies, tokens, or auth material. Use sparingly for stable preferences and environment facts the owner confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        fact_id: { type: "string", description: "Stable snake_case identifier, e.g. 'home-lab-server'." },
        text: { type: "string", description: "The fact itself, one concise sentence." },
        category: { type: "string", default: "general", description: "e.g. preferences, infrastructure, devices, projects." },
        scope: { type: "string", default: "global" },
        tags: { type: "array", items: { type: "string" } },
        priority: { type: "integer", default: 60, description: "0-100, higher is more important." },
      },
      required: ["fact_id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "list_notes",
    description: "List active shared notes in the current chat or workspace scope.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["global", "chat", "workspace"] },
        workspaceId: { type: "string" },
        includeArchived: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "search_notes",
    description: "Search shared notes by title or content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: { type: "string", enum: ["global", "chat", "workspace"] },
        workspaceId: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_note",
    description: "Create a shared note or project for the current chat. Use kind=project with todos for multi-chat planning. Deletion is intentionally not exposed to agents.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        kind: { type: "string", enum: ["note", "project"] },
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              chatIds: { type: "array", items: { type: "string" } },
            },
            required: ["content"],
            additionalProperties: false,
          },
        },
        color: { type: "string" },
        scope: { type: "string", enum: ["global", "chat", "workspace"] },
        workspaceId: { type: "string" },
        position: { type: "object", additionalProperties: true },
        size: { type: "object", additionalProperties: true },
        idempotencyKey: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_note",
    description: "Update a shared note using optimistic version checking.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        kind: { type: "string", enum: ["note", "project"] },
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              chatIds: { type: "array", items: { type: "string" } },
            },
            required: ["content"],
            additionalProperties: false,
          },
        },
        color: { type: "string" },
        archived: { type: "boolean" },
        version: { type: "number" },
        position: { type: "object", additionalProperties: true },
        size: { type: "object", additionalProperties: true },
        idempotencyKey: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_memories",
    description: "Retrieve the user's saved memories for the current account.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_memory",
    description: "Add a durable memory for the current user. Only save useful user-approved facts or preferences.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_memory",
    description: "Edit one existing memory by id for the current user.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_memory",
    description: "Delete one existing memory by id for the current user.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_workspaces",
    description: "List plan and canvas workspaces in the current chat.",
    inputSchema: {
      type: "object",
      properties: { type: { type: "string", enum: ["plan", "canvas"] } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "delete_plan",
    description: "Delete a plan workspace by id after confirmation.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_canvas",
    description: "Delete a canvas workspace by id after confirmation.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "git_status",
    description: "Return git status for the agent workspace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "git_diff",
    description: "Return the current unstaged git diff for the agent workspace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "browser_extract_text",
    description: "Extract readable text from the current browser page and all embedded frames. Use this instead of reloading or shell inspection.",
    inputSchema: { type: "object", properties: { tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "browser_form_state",
    description: "Return structured form controls plus compact text from the page and embedded frames. Controls include a frame hint and stable selector. Prefer this over screenshots or shell/Playwright inspection for forms.",
    inputSchema: { type: "object", properties: { tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "browser_batch",
    description: "Execute up to 100 browser actions in one round-trip, including embedded-frame controls. Use for repetitive form filling/clicking instead of one tool call per field.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." },
        include_snapshot: { type: "boolean", default: false },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["click", "type", "press", "scroll", "select_option", "hover", "wait_for"] },
              selector: { type: "string" },
              text: { type: "string" },
              key: { type: "string" },
              value: { type: "string" },
              delta_y: { type: "number" },
              exact: { type: "boolean" },
              timeout_ms: { type: "integer", minimum: 250, maximum: 30000 },
              frame: { type: "string", description: "Optional embedded-frame index or URL." },
            },
            required: ["action"],
            additionalProperties: false,
          },
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_wait_for",
    description: "Wait for a selector or visible text condition. Prefer this over fixed wait/sleep calls.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        exact: { type: "boolean", default: true },
        timeout_ms: { type: "integer", minimum: 250, maximum: 30000, default: 5000 },
        tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_fill_form",
    description: "Fill a browser form field using a CSS selector.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, text: { type: "string" }, tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." } },
      required: ["selector", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_download",
    description: "Trigger a download from the current browser page by clicking a CSS selector.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." } },
      required: ["selector"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_drag",
    description: "Drag an element to a target element (HTML5 and mouse-based drag & drop).",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, target_selector: { type: "string" }, tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." } },
      required: ["selector", "target_selector"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_hover",
    description: "Hover over an element by CSS selector (reveals hover menus and tooltips).",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." } },
      required: ["selector"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_select_option",
    description: "Select an option in a <select> dropdown by value.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, value: { type: "string" }, tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." } },
      required: ["selector", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_upload_file",
    description: "Upload a local file into a file input on the current browser page.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, file_path: { type: "string" }, tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." } },
      required: ["selector", "file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "gateway_status",
    description: `Show ${APP_NAME} gateway health, devices, enabled child MCP servers, and Windows desktop runner state. Call only when diagnosing the gateway — not at the start of ordinary tasks.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_mcp_servers",
    description: "List the dynamic MCP registry. Disabled entries show integrations that still need authorization.",
    inputSchema: { type: "object", properties: { include_disabled: { type: "boolean", default: true } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "search_tools",
    description: "Search tools on enabled child MCP servers. Use only when you do not already know the gateway tool name (read_file, edit_file, execute_command, …). Do not call this at the start of ordinary tasks.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        server: { type: "string", description: "Optional child MCP id." },
        limit: { type: "integer", default: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_server_tools",
    description: "List full tool schemas from one child MCP server.",
    inputSchema: { type: "object", properties: { server: { type: "string" }, refresh: { type: "boolean", default: false } }, required: ["server"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "call_mcp_tool",
    description: "Call any tool exposed by a registered child MCP server.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string" },
        tool: { type: "string" },
        arguments: { type: "object", additionalProperties: true, default: {} },
      },
      required: ["server", "tool"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_user",
    description: `Pause the agent and ask the signed-in ${APP_NAME} user one or more questions. Set multiple=true on a question when the user may select multiple options; the corresponding answer is returned as a JSON string array. The call remains pending until the user answers in the chat UI.`,
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              multiple: {
                type: "boolean",
                default: false,
                description: "Allow the user to select multiple options for this question.",
              },
              options: { type: "array", items: { type: "string" }, maxItems: 12 },
            },
            required: ["question"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
  {
    name: "request_mode_change",
    description: "Required when the current mode cannot perform the user's requested action. Use the exact mode ID: agent for implementation/file changes, plan for read-only planning, or ask for read-only answers; custom mode IDs are supplied in the chat instructions. Opens a real confirmation prompt for switching this chat to another mode; do not ask the user to change modes manually in text. After confirmation the new policy applies immediately in this same run.",
    inputSchema: {
      type: "object",
      properties: {
        modeId: { type: "string", description: "Target built-in or custom mode id." },
        reason: { type: "string", description: "Why the mode change is needed." },
      },
      required: ["modeId"],
      additionalProperties: false,
    },
  },
  {
    name: "wait",
    description: "Pause this agent for a bounded amount of time. Use this when work is expected to finish asynchronously; the wait always has a server-enforced maximum.",
    inputSchema: {
      type: "object",
      properties: {
        duration: { type: "string", enum: ["10s", "60s", "5m"], default: "60s" },
        durationMs: { type: "integer", minimum: 1000, maximum: 900000 },
        reason: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "delegate_subagent",
    description: "Spawn a real provider-neutral Metis child agent with its own persistent chat/run. Use wait=false to launch independent workstreams in parallel, then subagent_status to collect them before final synthesis. The child inherits the parent mode policy, so delegation cannot bypass read-only restrictions.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short human-readable subagent name." },
        prompt: { type: "string", description: "Tight, self-contained delegated task. Avoid overlapping file ownership with sibling agents." },
        modelId: { type: "string", description: "Optional configured model id. Defaults to the configured subagent model, then the parent model." },
        modeId: { type: "string", description: "Optional narrower child mode when the parent is in Agent mode." },
        wait: { type: "boolean", default: true, description: "Wait for the child result. Set false when launching several independent subagents in parallel." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 1800000, default: 600000 },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "subagent_status",
    description: "Inspect delegated subagents for this chat and optionally wait for a status change. Returns compact status data while preserving full tool logs in the chat.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        waitMs: { type: "integer", minimum: 0, maximum: 300000, default: 0 },
        afterEventId: { type: "integer", minimum: 0, default: 0 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "ensure_capability",
    description: "Find an existing matching tool, or autonomously search the complete official MCP Registry, provision and probe the best supported MCP, then return its available tools. Use this when a requested capability is not already visible.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Concrete capability needed, for example PostgreSQL schema inspection, Jira issues, or PDF processing." },
        auto_provision: { type: "boolean", default: false },
        registry_limit: { type: "integer", default: 8, minimum: 1, maximum: 25 },
        method: { type: "string", enum: ["auto", "remote", "package"], default: "auto" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "sync_agent_knowledge",
    description: "Write or update managed MCP instructions for AGENTS.md, CLAUDE.md, GEMINI.md, Copilot, Cursor, and OpenCode on the server, Windows PC, or laptop.",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string", enum: ["server", "pc", "laptop"], default: "server" },
        project_path: { type: "string" },
        clients: { type: "array", items: { type: "string", enum: ["agents", "claude", "gemini", "copilot", "cursor", "opencode"] } },
      },
      required: ["project_path"],
      additionalProperties: false,
    },
  },
  {
    name: "upsert_mcp_server",
    description: "Add or update a remote URL or stdio MCP server in the dynamic registry. The server remains centrally available through this gateway URL.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{1,63}$" },
        name: { type: "string" },
        kind: { type: "string", enum: ["remote", "stdio"] },
        url: { type: "string" },
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        env: { type: "object", additionalProperties: { type: "string" } },
        headers: { type: "object", additionalProperties: { type: "string" } },
        enabled: { type: "boolean", default: true },
        tags: { type: "array", items: { type: "string" } },
        note: { type: "string" },
      },
      required: ["id", "name", "kind"],
      additionalProperties: false,
    },
  },
  {
    name: "set_mcp_server_enabled",
    description: "Enable or disable one child MCP server.",
    inputSchema: { type: "object", properties: { server: { type: "string" }, enabled: { type: "boolean" } }, required: ["server", "enabled"], additionalProperties: false },
  },
  {
    name: "web_search",
    description: "Search the current web through the local SearXNG instance first, with Exa as fallback. Suitable for current information, products, code, and research.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        num_results: { type: "integer", minimum: 1, maximum: 100, default: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "web_fetch",
    description: "Fetch and extract one or more public read-only web pages. Uses the local Scrapling static scraper first for speed, then Exa as fallback. If a page requires login, interaction, JavaScript state, or a challenge, use the persistent browser_* tools instead.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, urls: { type: "array", items: { type: "string" } } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "browser_navigate",
    description: "Navigate the server-side browser to an allowed URL. The browser can reach server localhost URLs from the configured allowlist.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." } }, required: ["url"], additionalProperties: false },
  },
  {
    name: "browser_snapshot",
    description: "Return the current server-browser accessibility snapshot for selecting and understanding page elements.",
    inputSchema: { type: "object", properties: { tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "browser_screenshot",
    description: "Capture the current server-browser page as a JPEG and return it to the agent. Use only when visual inspection is necessary.",
    inputSchema: { type: "object", properties: { tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "browser_click",
    description: "Click a page element by CSS selector, exact/partial visible text, or viewport coordinates. Selectors/text are searched across embedded frames automatically.",
    inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, exact: { type: "boolean", default: true }, timeout_ms: { type: "integer", minimum: 250, maximum: 30000 }, x: { type: "number" }, y: { type: "number" }, tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." } }, additionalProperties: false },
  },
  {
    name: "browser_type",
    description: "Fill a page input by selector or type at the current focus. Selectors are searched across embedded frames automatically.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, selector: { type: "string" }, tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." } }, required: ["text"], additionalProperties: false },
  },
  {
    name: "browser_press",
    description: "Press a keyboard key in the server browser.",
    inputSchema: { type: "object", properties: { key: { type: "string" }, tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." } }, required: ["key"], additionalProperties: false },
  },
  {
    name: "browser_resize",
    description: "Set the server-browser viewport resolution for the current tab.",
    inputSchema: { type: "object", properties: { width: { type: "integer", minimum: 320, maximum: 2560 }, height: { type: "integer", minimum: 240, maximum: 1600 }, tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." } }, required: ["width", "height"], additionalProperties: false },
  },
  {
    name: "browser_scroll",
    description: "Scroll the current server-browser page vertically.",
    inputSchema: { type: "object", properties: { delta_y: { type: "number", default: 600 }, tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." } }, additionalProperties: false },
  },
  {
    name: "browser_tabs",
    description: "List and select tabs in the current server-browser session.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "new", "close", "select"] }, tab_id: { type: "string" }, frame: { type: "string", description: "Optional frame index or frame URL returned by browser_form_state." } }, additionalProperties: false },
  },
  {
    name: "context7_resolve",
    description: "Resolve a library name to the best Context7 library id before querying documentation.",
    inputSchema: { type: "object", properties: { library_name: { type: "string" }, query: { type: "string" } }, required: ["library_name", "query"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "context7_query",
    description: "Retrieve current, version-specific library documentation from Context7.",
    inputSchema: { type: "object", properties: { library_id: { type: "string" }, query: { type: "string" } }, required: ["library_id", "query"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "system_info",
    description: "Get system overview for the server, CachyOS laptop, or Windows PC.",
    inputSchema: { type: "object", properties: { target: targetProp }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "execute_command",
    description: "Run Bash on server/laptop or PowerShell on the Windows PC. Use dedicated Windows UI and Electron tools for visible desktop testing.",
    inputSchema: {
      type: "object",
      properties: {
        target: targetProp,
        command: { type: "string" },
        cwd: { type: "string" },
        timeout: { type: "integer", default: 60, maximum: 3600 },
        sudo: { type: "boolean", default: false },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "remote_client_terminal",
    description: "Open and control a persistent shell session on a connected remote client. The session keeps its working directory and environment between calls.",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        action: { type: "string", enum: ["open", "input", "close"] },
        cwd: { type: "string" },
        session_id: { type: "string" },
        data: { type: "string" },
      },
      required: ["client_id", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "list_remote_clients",
    description: "List the connected remote clients belonging to the current account, including their IDs, capabilities, policy, and online status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_directory",
    description: "List a directory on any device.",
    inputSchema: { type: "object", properties: { target: targetProp, path: { type: "string" } }, required: ["path"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file from the server or a connected remote client. Prefer offset+limit around the relevant region instead of reading the whole file. For a client use target client:<remote-client-id>.",
    inputSchema: { type: "object", properties: { target: targetProp, path: { type: "string" }, offset: { type: "integer", default: 1 }, limit: { type: "integer", default: 200 } }, required: ["path"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "repo_search",
    description: "Search the persistent local repository index for relevant files, symbols, imports, and paths before broad filesystem exploration.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Repository root. Defaults to the current agent workspace." },
        query: { type: "string" },
        limit: { type: "integer", default: 20, maximum: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "inspect_codebase",
    description: "Return compact indexed codebase findings for a query without dumping whole files.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Repository root. Defaults to the current agent workspace." },
        query: { type: "string" },
        limit: { type: "integer", default: 12, maximum: 50 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "verify_work",
    description:
      "Prove work claims with real command output instead of asserting them. Each claim pairs a short label with a command and expected output markers; every command is executed and the result recorded in a per-job evidence ledger (see ledger_review). Use for 'tests pass', 'server is up', 'config applied' style claims. Max 10 claims per call.",
    inputSchema: {
      type: "object",
      properties: {
        claims: {
          type: "array",
          description: "Claims to verify. Each needs label, command, and expect markers.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short claim, e.g. 'build passes'" },
              command: { type: "string", description: "Shell command that proves the claim." },
              expect: {
                type: "array",
                items: { type: "string" },
                description: "Substrings that must appear in combined stdout+stderr.",
              },
              reject: {
                type: "array",
                items: { type: "string" },
                description: "Substrings that must NOT appear (e.g. 'error', 'fail').",
              },
              timeout: { type: "integer", default: 30, maximum: 120 },
              target: { type: "string", default: "server", description: "server | laptop | pc" },
            },
            required: ["label", "command"],
            additionalProperties: false,
          },
        },
      },
      required: ["claims"],
      additionalProperties: false,
    },
  },
  {
    name: "ledger_review",
    description:
      "Read the evidence ledger for the current job: every verify_work claim with verified/failed status. Use before reporting task completion so the summary cites real evidence.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "audio_fingerprint",
    description:
      "Identify or register audio Shazam-style: spectral landmark hashing against a local reference database. Actions: match (identify an audio file), ingest (register a reference track with title/artist), stats (database overview). Requires ffmpeg. Audio argument may be any file ffmpeg can decode.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["match", "ingest", "stats"], description: "match = identify, ingest = register reference, stats = db overview." },
        audio: { type: "string", description: "Path or URL of the audio (required for match/ingest)." },
        title: { type: "string", description: "Track title (ingest only)." },
        artist: { type: "string", description: "Track artist (ingest only)." },
        source: { type: "string", description: "Where the reference came from, e.g. a URL (ingest only)." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "find_symbol",
    description: "Find functions, classes, interfaces, types, and exported symbols through the persistent repository index.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Repository root. Defaults to the current agent workspace." },
        symbol: { type: "string" },
        limit: { type: "integer", default: 20, maximum: 100 },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write_file",
    description: "Create or overwrite a UTF-8 text file on the server or a connected remote client. For a client use target client:<remote-client-id>.",
    inputSchema: { type: "object", properties: { target: targetProp, path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
  },
  {
    name: "edit_file",
    description: "Replace one exact oldText block with newText in a UTF-8 file on the server or a connected remote client. Pass the smallest unique snippet, never the whole file. For a client use target client:<remote-client-id>.",
    inputSchema: {
      type: "object",
      properties: { target: targetProp, path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description: "Delete a file on the server or a connected remote client. For a client use target client:<remote-client-id>.",
    inputSchema: { type: "object", properties: { target: targetProp, path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "docker_ps",
    description: "List Docker containers on a Linux device.",
    inputSchema: { type: "object", properties: { target: targetProp, all: { type: "boolean", default: true } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "service_control",
    description: "Inspect, restart, start, stop, or read logs for a systemd service on server/laptop.",
    inputSchema: {
      type: "object",
      properties: {
        target: targetProp,
        action: { type: "string", enum: ["status", "restart", "start", "stop", "logs"] },
        service: { type: "string" },
        user_service: { type: "boolean", default: false },
        lines: { type: "integer", default: 150 },
      },
      required: ["action", "service"],
      additionalProperties: false,
    },
  },
  {
    name: "windows_ui",
    description: "Inspect and control visible Windows applications through Microsoft's winapp UI Automation. Supports Electron, Win32, WPF, WinForms, and WinUI. Actions include list-windows, inspect, search, status, get-property, get-value, invoke, click, set-value, send-keys, focus, hover, scroll, wait-for, screenshot, and record.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        selector: { type: "string" },
        second: { type: "string", description: "Second positional value, such as set-value value or drag destination." },
        app: { type: "string", description: "Process/app name used with -a." },
        window: { type: "string", description: "Window HWND used with -w." },
        extra_args: { type: "array", items: { type: "string" } },
        timeout: { type: "integer", default: 120, maximum: 3600 },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "windows_screenshot",
    description: "Capture a visible Windows app or UI element and return the PNG directly to the agent.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", default: "window" },
        app: { type: "string" },
        window: { type: "string" },
        capture_screen: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "electron_test",
    description: "Analyze, install, audit, lint, type-check, unit-test, E2E-test, build, package, launch, or comprehensively validate an Electron project on the Windows PC. Use full first, then launch and windows_ui/windows_screenshot for feature-by-feature visual validation.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string", description: "Absolute Windows project directory, for example C:\\Users\\User\\Documents\\Pointer." },
        action: { type: "string", enum: ["analyze", "install", "audit", "lint", "typecheck", "unit", "e2e", "build", "package", "full", "launch"] },
        command: { type: "string", description: "Optional explicit command override." },
        timeout: { type: "integer", default: 1800, maximum: 3600 },
      },
      required: ["project_path", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "windows_desktop_job",
    description: "Run an arbitrary command inside the active interactive Windows desktop session. Use only when windows_ui or electron_test cannot express the operation.",
    inputSchema: {
      type: "object",
      properties: {
        command: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        cwd: { type: "string", default: "C:\\Users\\User" },
        action: { type: "string", enum: ["run", "spawn"], default: "run" },
        timeout: { type: "integer", default: 600, maximum: 3600 },
        env: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "workflow_save",
    description: "Save a reusable workflow of allowlisted core gateway tool calls.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string", default: "" }, steps: { type: "array", minItems: 1, maxItems: 25, items: { type: "object", properties: { tool: { type: "string", enum: ["execute_command", "service_control", "docker_ps", "system_info", "list_directory", "read_file", "write_file", "electron_test", "windows_desktop_job", "windows_ui"] }, arguments: { type: "object" } }, required: ["tool", "arguments"], additionalProperties: false } }, overwrite: { type: "boolean", default: false } }, required: ["name", "description", "steps"], additionalProperties: false },
  },
  { name: "workflow_list", description: "List saved workflows.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "workflow_get", description: "Get a saved workflow.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "workflow_delete", description: "Delete a saved workflow.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } },
  { name: "workflow_run", description: "Run a saved workflow in order, stopping at the first failure. Use dry_run to validate without device side effects.", inputSchema: { type: "object", properties: { name: { type: "string" }, dry_run: { type: "boolean", default: false } }, required: ["name"], additionalProperties: false } },
  { name: "assistant_status", description: "Return compact live status for all devices, gateway services, and available tool count.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  {
    name: "gateway_bootstrap",
    description: "Return the public bootstrap document with connection URL, transport, and discovery tool names.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "search_registry",
    description: "Search the complete mirrored official MCP Registry for installable servers. Delegates to the registry-autobroker child.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", default: 20 },
        installable_only: { type: "boolean", default: false },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "registry_status",
    description: "Show official MCP Registry sync state, catalog version, total entries, and knowledge targets.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "registry_changes",
    description: "Return catalog additions, updates, deletions, and provisioning events after a timestamp.",
    inputSchema: {
      type: "object",
      properties: { since: { type: "string" }, limit: { type: "integer", default: 100 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "provision_registry_server",
    description: "Provision a public Streamable HTTP, npm, PyPI, or OCI MCP from the official registry in a restricted Docker runtime.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        method: { type: "string", enum: ["auto", "remote", "package"], default: "auto" },
        enable: { type: "boolean", default: true },
        probe: { type: "boolean", default: true },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "test_mcp_server",
    description: "Run an MCP handshake (initialize + tools/list) against a registered server and return the result without enabling it.",
    inputSchema: {
      type: "object",
      properties: { server: { type: "string" } },
      required: ["server"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "sync_project_rules",
    description: "Register a project path for automatic MCP knowledge synchronization on all configured devices.",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string", enum: ["server", "pc", "laptop"], default: "server" },
        project_path: { type: "string" },
        clients: { type: "array", items: { type: "string", enum: ["agents", "claude", "gemini", "copilot", "cursor", "opencode"] } },
      },
      required: ["project_path"],
      additionalProperties: false,
    },
  },
  {
    name: "get_catalog_version",
    description: "Return the current official MCP Registry catalog version, entry count, and last sync time.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_catalog_changes",
    description: "Return recent changes from the official MCP Registry catalog since a given timestamp.",
    inputSchema: {
      type: "object",
      properties: { since: { type: "string" }, limit: { type: "integer", default: 50 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_recent_errors",
    description: "List recent centralized Metis error logs. Use first when the user reports a UI/UX bug or something feels broken.",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "number", default: 24, minimum: 0.01 },
        source: { type: "string", enum: ["frontend", "api", "worker", "ws", "telegram", "browser", "system"] },
        level: { type: "string", enum: ["error", "warn", "info"] },
        limit: { type: "integer", default: 50, minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_error_log_detail",
    description: "Read one full error log entry, including stack and context JSON.",
    inputSchema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "clear_error_logs",
    description: "Delete error logs older than older_than_hours (default 336 = 14 days). Destructive diagnostic cleanup.",
    inputSchema: { type: "object", properties: { older_than_hours: { type: "number", default: 336, minimum: 1 } }, additionalProperties: false },
  },
  {
    name: "get_connection_instructions",
    description: "Return client-specific MCP connection configuration for Claude Code, Codex, Hermes, Gemini CLI, OpenCode, and Cursor.",
    inputSchema: {
      type: "object",
      properties: { client: { type: "string", description: "Optional client name to filter (claude, codex, hermes, gemini, opencode, cursor)." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

function createServerForSession(context = {}) {
  const server = new Server(
    { name: `${APP_NAME} Universal MCP Gateway`, version: "4.0.0" },
    {
      capabilities: { tools: {} },
      instructions: `This single remote MCP endpoint is the universal tool gateway. Call known tools directly (read_file, edit_file, execute_command, …). Do not start ordinary tasks with gateway_status or search_tools. search_tools is only for unknown child-MCP capabilities. If a needed child capability is missing, call ensure_capability: it searches the complete mirrored official MCP Registry, provisions a supported server in a restricted runtime, probes its MCP handshake and tools, and makes it available without changing the client URL. Then use call_mcp_tool. Core tools handle current web search, Context7 docs, server/laptop/Windows administration, and interactive Windows/Electron testing. Use workflow_save/list/get/delete to manage durable multi-step routines and workflow_run with dry_run first to validate them; workflows run only allowlisted core tools and stop on failure. Use assistant_status for a compact live operational overview. If the active agent mode does not allow an action the user requested, you MUST call request_mode_change to open a user confirmation prompt; never tell the user to switch modes manually without making that tool call. File rule: whenever the user asks to attach, send, share, export, or provide a file, you MUST call provide_file for every file; writing a file, mentioning its path, or placing it in the workspace does not attach it. Device mapping: ${Object.entries(HOSTS).map(([k,v]) => `${k} = ${v.label}`).join("; ")}. For an Electron app, run electron_test action full, launch it, inspect every window and feature with windows_ui, capture screenshots, and iterate on failures. Never invent missing third-party credentials and do not claim complete coverage without reporting which scripts, windows, and flows were actually exercised.`,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visibleToolsForContext(context) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => dispatchGatewayTool(request.params.name, request.params.arguments || {}, { context }));
  return server;
}

const SHARED_BROWSER_TOOLS = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_wait_for",
  "browser_resize",
  "browser_tabs",
]);

function sharedBrowserArgs(tool, args = {}) {
  if (tool === "browser_navigate") return { url: args.url, tab_id: args.tab_id };
  if (tool === "browser_snapshot") return { tab_id: args.tab_id };
  if (tool === "browser_take_screenshot") return { tab_id: args.tab_id };
  if (tool === "browser_click") return {
    selector: args.target || args.selector,
    x: args.x,
    y: args.y,
    tab_id: args.tab_id,
  };
  if (tool === "browser_type") return {
    text: args.text,
    selector: args.target || args.selector,
    tab_id: args.tab_id,
  };
  if (tool === "browser_press_key") return { key: args.key, tab_id: args.tab_id };
  if (tool === "browser_wait_for") return {
    selector: args.selector || args.target,
    text: args.text,
    exact: args.exact,
    timeout_ms: args.time ? Math.round(Number(args.time) * 1000) : args.timeout_ms,
    tab_id: args.tab_id,
  };
  if (tool === "browser_resize") return {
    width: args.width,
    height: args.height,
    tab_id: args.tab_id,
  };
  if (tool === "browser_tabs") return {
    action: args.action,
    tab_id: args.index !== undefined ? args.index : args.tab_id,
  };
  return args;
}

async function callRemoteClientFromGateway(clientId, action, params, context) {
  const token = String(process.env.MCP_BEARER_TOKEN || "").trim();
  const response = await fetch(INTERNAL_REMOTE_CLIENT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-AI-Chat-User-Id": String(context.userId || ""),
    },
    body: JSON.stringify({
      clientId,
      action,
      params,
      runId: context.jobId,
      toolCallId: context.toolCallId,
      source: context.source === "agent" ? "agent" : "user",
    }),
    signal: AbortSignal.timeout(300_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Remote client request failed (HTTP ${response.status})`);
  return body.events ? { result: body.result, events: body.events } : body.result;
}

function visibleToolsForContext(context = {}) {
  // Discovery must use the same manifest gate as execution. A malformed or
  // tampered manifest fails closed instead of silently widening the catalog.
  return tools.filter((tool) => capabilityAllowsTool(tool.name, context));
}

async function dispatchGatewayTool(name, args = {}, options = {}) {
  if (!executionContext.getStore()) {
    const context = options.context || {};
    return executionContext.run(
      { identity: resolveExecutionIdentity(context), context },
      () => dispatchGatewayTool(name, args, options),
    );
  }
  const { auditCall = true, context = {} } = options;
    if (auditCall) await audit(name, args);
    try {
      assertToolPolicy(name, context, args);
      await ensureRuntimeApproval(name, args, context);
      if (
        LOCAL_FILE_TOOLS.has(name) &&
        !String(args.target || "server").startsWith("client:") &&
        String(args.target || "server") === "server"
      ) {
        const workspace = currentWorkspace();
        const filePath = typeof args.path === "string" ? args.path : "";
        const cwd = typeof args.cwd === "string" ? args.cwd : workspace;
        if (workspace && filePath && !isInsideWorkspace(workspace, filePath)) {
          throw new Error("Path must be inside the agent workspace.");
        }
        if (workspace && cwd && !isInsideWorkspace(workspace, cwd)) {
          throw new Error("Path must be inside the agent workspace.");
        }
      }
      if (name === "list_remote_clients") {
        const response = await fetch(INTERNAL_REMOTE_CLIENT_URL, {
          headers: {
            Authorization: `Bearer ${String(process.env.MCP_BEARER_TOKEN || "").trim()}`,
            "X-AI-Chat-User-Id": String(context.userId || ""),
          },
          signal: AbortSignal.timeout(15_000),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Failed to list remote clients");
        return asText(body.clients || []);
      }
      if (name === "remote_client_terminal") {
        const clientId = String(args.client_id || "").trim();
        const action = String(args.action || "");
        if (!clientId || !["open", "input", "close"].includes(action)) {
          throw new Error("client_id and a valid terminal action are required");
        }
        const remoteAction = action === "open" ? "pty_open" : action === "input" ? "pty_input" : "pty_close";
        const result = await callRemoteClientFromGateway(clientId, remoteAction, {
          ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
          ...(typeof args.session_id === "string" ? { sessionId: args.session_id } : {}),
          ...(typeof args.data === "string" ? { data: args.data } : {}),
        }, context);
        return asText(result);
      }
      if (typeof args.target === "string" && args.target.startsWith("client:")) {
        const clientId = args.target.slice("client:".length).trim();
        if (!clientId || !context.userId) throw new Error("A client target and authenticated account are required");
        const remoteAction =
          name === "system_info" ? "get_info" :
          name === "execute_command" ? "execute_command" :
          name === "list_directory" ? "list_directory" :
          name === "read_file" ? "read_file" :
          name === "write_file" ? "write_file" :
          name === "edit_file" ? "edit_file" :
          name === "delete_file" ? "delete_file" : null;
        if (!remoteAction) throw new Error(`Tool ${name} is not supported for remote clients`);
        const result = await callRemoteClientFromGateway(clientId, remoteAction, name === "system_info"
          ? {}
          : name === "read_file"
            ? { path: args.path, offset: args.offset, limit: args.limit }
            : args, context);
        return asText(result);
      }
      if (name === "write_todos") {
        const todos = Array.isArray(args.todos) ? args.todos.slice(0, 40).map((item, index) => {
          const entry = item && typeof item === "object" ? item : { content: String(item || "") };
          const content = String(entry.content || "").trim().slice(0, 300);
          if (!content) return null;
          const status = ["pending", "in_progress", "completed"].includes(String(entry.status || ""))
            ? String(entry.status)
            : "pending";
          return {
            id: String(entry.id || `todo-${index + 1}`).slice(0, 80),
            content,
            status,
          };
        }).filter(Boolean) : [];
        if (!todos.length) throw new Error("write_todos requires at least one todo with content");
        return asText({ todos });
      }
      if (name === "provide_file") {
        const chatId = String(context.chatId || "").trim();
        const jobId = String(context.jobId || "").trim();
        if (!chatId || !jobId) throw new Error("provide_file requires a chat session context");
        const response = await fetch(INTERNAL_FILE_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${String(process.env.MCP_BEARER_TOKEN || "").trim()}`,
            "X-AI-Chat-Id": chatId,
            "X-AI-Chat-User-Id": String(context.userId || ""),
            "X-AI-Chat-Job-Id": jobId,
            "X-AI-Chat-Incognito": context.incognito ? "1" : "0",
            ...internalLeaseHeaders(context),
          },
          body: JSON.stringify({
            path: String(args.path || ""),
            ...(args.name ? { name: String(args.name) } : {}),
            ...(args.mimeType ? { mimeType: String(args.mimeType) } : {}),
          }),
          signal: AbortSignal.timeout(30_000),
        });
        return asText(await readInternalJson(response, "File"));
      }
      if ([
        "create_automation", "list_automations", "update_automation", "run_automation",
        "pause_automation", "resume_automation", "delete_automation",
      ].includes(name)) {
        const action = name === "create_automation"
          ? "create"
          : name === "list_automations"
            ? "list"
            : name === "update_automation"
              ? "update"
              : name.replace("_automation", "");
        const response = await fetch(INTERNAL_AUTOMATION_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${String(process.env.MCP_BEARER_TOKEN || "").trim()}`,
            "X-AI-Chat-Id": String(context.chatId || ""),
            "X-AI-Chat-User-Id": String(context.userId || ""),
            "X-AI-Chat-Job-Id": String(context.jobId || ""),
          },
          body: JSON.stringify({ ...args, action }),
          signal: AbortSignal.timeout(30_000),
        });
        return asText(await readInternalJson(response, "Automation"));
      }
      if (name === "list_workspaces" || name === "delete_plan" || name === "delete_canvas") {
        const chatId = String(context.chatId || "").trim();
        const jobId = String(context.jobId || "").trim();
        if (!chatId || !jobId) throw new Error(`${name} requires a chat session context`);
        const type = name === "delete_plan" ? "plan" : name === "delete_canvas" ? "canvas" : args.type;
        const action = name === "list_workspaces" ? "list" : "delete";
        const response = await fetch(INTERNAL_WORKSPACE_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${String(process.env.MCP_BEARER_TOKEN || "").trim()}`,
            "X-AI-Chat-Id": chatId,
            "X-AI-Chat-User-Id": String(context.userId || ""),
            "X-AI-Chat-Job-Id": jobId,
            ...internalLeaseHeaders(context),
            "X-AI-Chat-Incognito": context.incognito ? "1" : "0",
          },
          body: JSON.stringify({ action, type, ...(action === "delete" ? { id: String(args.id || "") } : {}) }),
          signal: AbortSignal.timeout(30_000),
        });
        return asText(await readInternalJson(response, "Workspace"));
      }
      if (name === "create_plan" || name === "create_canvas" || name === "edit_plan" || name === "edit_canvas") {
        const type = name.endsWith("plan") ? "plan" : "canvas";
        const title = String(args.title || (type === "plan" ? "Plan" : "Canvas")).trim().slice(0, 200);
        const content = typeof args.content === "string" ? args.content : "";
        const chatId = String(context.chatId || "").trim();
        const jobId = String(context.jobId || "").trim();
        if (!chatId || !jobId) throw new Error(`${name} requires a chat session context`);
        const response = await fetch(INTERNAL_WORKSPACE_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${String(process.env.MCP_BEARER_TOKEN || "").trim()}`,
            "X-AI-Chat-Id": chatId,
            "X-AI-Chat-User-Id": String(context.userId || ""),
            "X-AI-Chat-Job-Id": jobId,
            "X-AI-Chat-Incognito": context.incognito ? "1" : "0",
            ...internalLeaseHeaders(context),
          },
          body: JSON.stringify({
            type,
            title,
            content,
            idempotencyKey: String(args.idempotencyKey || `${jobId}:${name}:${title}`).slice(0, 200),
            ...(name.startsWith("edit_") ? { action: "edit", id: String(args.id || "") } : {}),
          }),
          signal: AbortSignal.timeout(30_000),
        });
        return asText(await readInternalJson(response, "Workspace"));
      }
      if (name === "update_chat_title" || name === "update_chat_keywords" || name === "search_chats") {
        const chatId = String(context.chatId || "").trim();
        const jobId = String(context.jobId || "").trim();
        if (!chatId || !jobId) throw new Error(`${name} requires a chat session context`);
        if (name === "update_chat_title") {
          const title = String(args.title || "").trim().slice(0, 200);
          if (!title) throw new Error("title is required");
          const answer = await fetch(INTERNAL_CHAT_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${String(process.env.MCP_BEARER_TOKEN || "").trim()}`,
              "X-AI-Chat-Id": chatId,
              "X-AI-Chat-User-Id": String(context.userId || ""),
              "X-AI-Chat-Job-Id": jobId,
              ...internalLeaseHeaders(context),
            },
            body: JSON.stringify({ action: "title", title }),
            signal: AbortSignal.timeout(30_000),
          });
          const body = await answer.text();
          if (!answer.ok) throw new Error(`Chat title update failed (HTTP ${answer.status}): ${body.slice(0, 500)}`);
          try { return asText(JSON.parse(body)); } catch { return asText({ result: body }); }
        }
        const response = await fetch(INTERNAL_CHAT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${String(process.env.MCP_BEARER_TOKEN || "").trim()}`,
            "X-AI-Chat-Id": chatId,
            "X-AI-Chat-User-Id": String(context.userId || ""),
            "X-AI-Chat-Job-Id": jobId,
            "X-AI-Chat-Incognito": context.incognito ? "1" : "0",
            ...internalLeaseHeaders(context),
          },
          body: JSON.stringify({
            ...args,
            action: name === "search_chats" ? "search" : "update",
          }),
          signal: AbortSignal.timeout(30_000),
        });
        const body = await response.text();
        if (!response.ok) throw new Error(`Chat metadata endpoint failed (HTTP ${response.status}): ${body.slice(0, 500)}`);
        return asText(JSON.parse(body));
      }
      if (name === "list_notes" || name === "search_notes" || name === "create_note" || name === "update_note") {
        const chatId = String(context.chatId || "").trim();
        const jobId = String(context.jobId || "").trim();
        if (!chatId || !jobId) throw new Error(`${name} requires a chat session context`);
        const action = name === "list_notes"
          ? "list"
          : name === "search_notes"
            ? "search"
            : name === "create_note"
              ? "create"
              : "update";
        const response = await fetch(INTERNAL_NOTES_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${String(process.env.MCP_BEARER_TOKEN || "").trim()}`,
            "X-AI-Chat-Id": chatId,
            "X-AI-Chat-User-Id": String(context.userId || ""),
            "X-AI-Chat-Job-Id": jobId,
            "X-AI-Chat-Incognito": context.incognito ? "1" : "0",
          },
          body: JSON.stringify({ ...args, action }),
          signal: AbortSignal.timeout(30_000),
        });
        const body = await response.text();
        if (!response.ok) throw new Error(`Notes endpoint failed (HTTP ${response.status}): ${body.slice(0, 500)}`);
        return asText(JSON.parse(body));
      }
      if (name === "context_search" || name === "context_profile" || name === "context_remember") {
        if (name === "context_remember" && context.incognito) {
          throw new Error("context_remember is unavailable in Incognito.");
        }
        const hubBase = String(process.env.CONTEXT_HUB_URL || "http://127.0.0.1:18083").replace(/\/+$/, "");
        const hubPath = name === "context_search" ? "/v1/context" : name === "context_profile" ? "/v1/profile" : "/v1/facts";
        const payload = name === "context_search"
          ? {
              query: String(args.query || ""),
              project_name: typeof args.project_name === "string" ? args.project_name : "",
              max_chars: Number.isFinite(args.max_chars) ? Math.min(Math.max(Number(args.max_chars), 500), 12000) : 4000,
            }
          : name === "context_profile"
            ? undefined
            : {
                id: String(args.fact_id || ""),
                text: String(args.text || ""),
                category: typeof args.category === "string" && args.category ? args.category : "general",
                scope: typeof args.scope === "string" && args.scope ? args.scope : "global",
                tags: Array.isArray(args.tags) ? args.tags.map((tag) => String(tag)) : [],
                priority: Number.isFinite(args.priority) ? Number(args.priority) : 60,
                source: "metis",
              };
        if (!hubPath) throw new Error("Unknown context hub tool");
        if (name === "context_search" && !payload.query) throw new Error("query is required");
        if (name === "context_remember" && (!payload.id || !payload.text)) throw new Error("fact_id and text are required");
        const response = await fetch(hubBase + hubPath, {
          method: payload ? "POST" : "GET",
          headers: { "Content-Type": "application/json" },
          body: payload ? JSON.stringify(payload) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
        const body = await response.text();
        if (!response.ok) throw new Error(`Context hub failed (HTTP ${response.status}): ${body.slice(0, 300)}`);
        return asText((() => { try { return JSON.parse(body); } catch { return { raw: body.slice(0, 2000) }; } })());
      }
      if (name === "list_memories" || name === "add_memory" || name === "edit_memory" || name === "delete_memory") {
        const chatId = String(context.chatId || "").trim();
        const jobId = String(context.jobId || "").trim();
        if (!chatId || !jobId) throw new Error(`${name} requires a chat session context`);
        const action = name === "list_memories" ? "list" : name === "add_memory" ? "add" : name === "edit_memory" ? "edit" : "delete";
        const response = await fetch(INTERNAL_MEMORY_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${String(process.env.MCP_BEARER_TOKEN || "").trim()}`,
            "X-AI-Chat-Id": chatId,
            "X-AI-Chat-User-Id": String(context.userId || ""),
            "X-AI-Chat-Job-Id": jobId,
          },
          body: JSON.stringify({ ...args, action }),
          signal: AbortSignal.timeout(30_000),
        });
        const body = await response.text();
        if (!response.ok) throw new Error(`Memory endpoint failed (HTTP ${response.status}): ${body.slice(0, 500)}`);
        return asText(JSON.parse(body));
      }
      if (name === "list_recent_errors") {
        const db = await errorLogDb();
        const hours = Math.max(0.01, Number(args.hours || 24));
        const limit = Math.max(1, Math.min(Number(args.limit || 50), 500));
        const since = Date.now() - hours * 3600_000;
        const conditions = ["ts >= ?"];
        const params = [since];
        if (args.source) { conditions.push("source = ?"); params.push(String(args.source)); }
        if (args.level) { conditions.push("level = ?"); params.push(String(args.level)); }
        if (context.chatId) { conditions.push("chat_id = ?"); params.push(String(context.chatId)); }
        const rows = db.prepare(`SELECT id, ts, level, source, chat_id, message FROM error_logs WHERE ${conditions.join(" AND ")} ORDER BY ts DESC LIMIT ${limit}`).all(...params);
        return asText(rows.map((row) => ({
          id: row.id,
          at: new Date(row.ts).toISOString(),
          level: row.level,
          source: row.source,
          chatId: row.chat_id,
          message: String(row.message).slice(0, 500),
        })));
      }
      if (name === "read_error_log_detail") {
        const db = await errorLogDb();
        const row = db.prepare("SELECT * FROM error_logs WHERE id = ?").get(Number(args.id));
        if (!row) return asText({ error: `No error log entry with id ${args.id}` });
        let parsedContext = null;
        try { parsedContext = row.context ? JSON.parse(row.context) : null; } catch { parsedContext = { raw: String(row.context).slice(0, 2000) }; }
        return asText({
          id: row.id, at: new Date(row.ts).toISOString(), level: row.level, source: row.source,
          chatId: row.chat_id, userId: row.user_id, sessionLabel: row.session_label,
          message: row.message, stack: row.stack || undefined, context: parsedContext,
        });
      }
      if (name === "clear_error_logs") {
        const db = await errorLogDb();
        const hours = Math.max(1, Number(args.older_than_hours || 336));
        const cutoff = Date.now() - hours * 3600_000;
        const result = db.prepare("DELETE FROM error_logs WHERE ts < ?").run(cutoff);
        return asText({ ok: true, deleted: result.changes, olderThanHours: hours, cutoff: new Date(cutoff).toISOString() });
      }
      if (name === "gateway_status") {
        const registry = visibleRegistry(await loadRegistry(), context);
        return asText({
          name: `${APP_NAME} Universal MCP Gateway`,
          version: "4.0.0",
          endpoint: `${PUBLIC_URL}/all`,
          devices: HOSTS,
          enabled_servers: registry.filter((s) => s.enabled).map((s) => s.id),
          active_children: [...childCache.values()].map((child) => child.entry.id),
        });
      }
      if (name === "list_mcp_servers") {
        const registry = visibleRegistry(await loadRegistry(), context)
          .filter((server) => childMcpAllows(server.id, "*", context));
        const selected = args.include_disabled === false ? registry.filter((s) => s.enabled) : registry;
        return asText(selected.map(({ env, headers, ...s }) => ({ ...s, configured_env_keys: Object.keys(env || {}), configured_header_keys: Object.keys(headers || {}) })));
      }
      if (name === "search_tools") {
        const registry = visibleRegistry(await loadRegistry(), context)
          .filter((s) => childMcpAllows(s.id, "*", context))
          .filter((s) => s.enabled && (!args.server || s.id === args.server));
        const query = String(args.query || "").trim();
        const limit = Math.max(1, Math.min(Number(args.limit || 20), 100));
        if (!query) return asText({ tools: [], errors: [{ server: "*", error: "query is required" }] });
        return asText(await searchEnabledChildTools(registry, query, limit, context));
      }
      if (name === "list_server_tools") {
        const serverId = String(args.server || "").trim();
        if (!serverId) throw new Error("server is required");
        if (!childMcpAllows(serverId, "*", context)) {
          throw new Error(`Child MCP server ${serverId} is not granted by the run capability manifest.`);
        }
        return asText(await childTools(serverId, Boolean(args.refresh), context));
      }
      if (name === "call_mcp_tool") {
        const childToolName = String(args.tool || "").trim();
        const childServerName = String(args.server || "").trim();
        if (!childServerName || !childToolName) throw new Error("server and tool are required");
        assertChildMcpGrant(childServerName, childToolName, context);
        const childToolCatalog = await childTools(childServerName, false, context);
        if (!childToolCatalog.some((tool) => tool && tool.name === childToolName)) {
          throw new Error(`MCP tool ${childServerName}/${childToolName} was not found in the server tool catalog`);
        }
        // Playwright is exposed as a compatibility MCP server, but browser
        // actions must use the same chat-scoped session as the workspace.
        if (args.server === "playwright" && SHARED_BROWSER_TOOLS.has(args.tool)) {
          return await dispatchGatewayTool(
            args.tool === "browser_take_screenshot"
              ? "browser_screenshot"
              : args.tool === "browser_press_key"
                ? "browser_press"
                : args.tool === "browser_wait_for"
                  ? "browser_wait_for"
                  : args.tool,
            sharedBrowserArgs(args.tool, args.arguments || {}),
            { context, auditCall: false },
          );
        }
        return returnChildResult(await callChild(args.server, args.tool, args.arguments || {}, context));
      }
      if (name === "ask_user") {
        const chatId = String(context.chatId || "").trim();
        const jobId = String(context.jobId || "").trim();
        if (!chatId || !jobId) throw new Error(`ask_user requires a ${APP_NAME} session context`);
        const baseUrl = INTERNAL_URL;
        const token = String(process.env.MCP_BEARER_TOKEN || "").trim();
        const response = await fetch(baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "X-AI-Chat-Id": chatId,
            "X-AI-Chat-User-Id": String(context.userId || ""),
            "X-AI-Chat-Job-Id": jobId,
            "X-AI-Chat-Automation": context.automation ? "1" : "0",
          },
          body: JSON.stringify({ questions: args.questions }),
          signal: AbortSignal.timeout(16 * 60 * 1000),
        });
        const body = await response.text();
        if (!response.ok) throw new Error(`${APP_NAME} question endpoint failed (HTTP ${response.status}): ${body.slice(0, 500)}`);
        try { return asText(JSON.parse(body)); }
        catch { return asText(body); }
      }
      if (name === "request_mode_change") {
        const modeId = String(args.modeId || "").trim();
        if (!modeId) throw new Error("modeId is required");
        const answer = await dispatchGatewayTool("ask_user", {
          questions: [{
            question: `Switch this chat to mode "${modeId}"?${args.reason ? `\n\nReason: ${String(args.reason).slice(0, 1_000)}` : ""}`,
            options: ["Accept", "Cancel"],
          }],
        }, { context, auditCall: false });
        const answerText = childResultText(answer);
        if (!/\baccept\b/i.test(answerText) || /\bcancel\b/i.test(answerText)) return asText({ switched: false, modeId });
        const response = await fetch(INTERNAL_URL.replace("/api/internal/mcp-question", "/api/internal/mcp-mode"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${String(process.env.MCP_BEARER_TOKEN || "").trim()}`,
            "X-AI-Chat-Id": String(context.chatId || ""),
            "X-AI-Chat-User-Id": String(context.userId || ""),
            "X-AI-Chat-Job-Id": String(context.jobId || ""),
          },
          body: JSON.stringify({ modeId }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`Mode switch failed (HTTP ${response.status})`);
        const switched = await response.json().catch(() => ({}));
        const switchedMode = switched?.mode;
        if (switchedMode && typeof switchedMode === "object") {
          context.modeId = String(switchedMode.id || modeId);
          context.modePolicy = JSON.stringify({
            allowedCategories: Array.isArray(switchedMode.allowedCategories) ? switchedMode.allowedCategories : [],
            toolOverrides: switchedMode.toolOverrides || {},
          });
        }
        return asText({ switched: true, modeId, currentRun: true, instruction: "Continue the original request now using the newly allowed tools." });
      }
      if (name === "delegate_subagent") {
        const chatId = String(context.chatId || "").trim();
        const jobId = String(context.jobId || "").trim();
        if (!chatId || !jobId) throw new Error(`delegate_subagent requires a ${APP_NAME} session context`);
        const token = String(process.env.MCP_BEARER_TOKEN || "").trim();
        const timeoutMs = Number.isFinite(Number(args.timeoutMs))
          ? Math.min(1_800_000, Math.max(1_000, Math.floor(Number(args.timeoutMs))))
          : 600_000;
        const response = await fetch(INTERNAL_SUBAGENT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "X-AI-Chat-Id": chatId,
            "X-AI-Chat-User-Id": String(context.userId || ""),
            "X-AI-Chat-Job-Id": jobId,
          },
          body: JSON.stringify({
            title: args.title,
            prompt: args.prompt,
            modelId: args.modelId,
            modeId: args.modeId,
            wait: args.wait,
            timeoutMs,
          }),
          signal: AbortSignal.timeout(args.wait === false ? 30_000 : timeoutMs + 30_000),
        });
        const responseBody = await response.text();
        if (!response.ok) throw new Error(`${APP_NAME} subagent endpoint failed (HTTP ${response.status}): ${responseBody.slice(0, 1000)}`);
        try { return asText(JSON.parse(responseBody)); }
        catch { return asText(responseBody); }
      }
      if (name === "wait" || name === "subagent_status") {
        const chatId = String(context.chatId || "").trim();
        const jobId = String(context.jobId || "").trim();
        if (!chatId || !jobId) throw new Error(`${name} requires a ${APP_NAME} session context`);
        const token = String(process.env.MCP_BEARER_TOKEN || "").trim();
        const headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-AI-Chat-Id": chatId,
          "X-AI-Chat-User-Id": String(context.userId || ""),
          "X-AI-Chat-Job-Id": jobId,
        };
        const body = name === "wait"
          ? {
              action: "wait",
              duration: args.duration,
              durationMs: args.durationMs,
              reason: args.reason,
            }
          : {
              action: "status",
              agentId: args.agentId,
              waitMs: args.waitMs,
              afterEventId: args.afterEventId,
            };
        const response = await fetch(INTERNAL_AGENT_STATE_URL, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(name === "wait" ? 16 * 60 * 1000 : 5 * 60 * 1000),
        });
        const responseBody = await response.text();
        if (!response.ok) throw new Error(`${APP_NAME} agent state endpoint failed (HTTP ${response.status}): ${responseBody.slice(0, 500)}`);
        try { return asText(JSON.parse(responseBody)); }
        catch { return asText(responseBody); }
      }
      if (name === "git_status" || name === "git_diff") {
        const command = name === "git_status" ? "git status --short --branch" : "git diff --no-ext-diff";
        return asText(await runShell({
          target: "server",
          cwd: currentWorkspace() || ROOT,
          timeout: 60,
          command,
        }));
      }
      if (name === "repo_search" || name === "inspect_codebase" || name === "find_symbol") {
        const root = path.resolve(String(args.root || currentWorkspace() || ROOT));
        if (name === "find_symbol") {
          return asText(await findSymbol(root, String(args.symbol || ""), { limit: args.limit }));
        }
        const query = String(args.query || "").trim();
        if (!query) throw new Error("query is required");
        const result = name === "repo_search"
          ? await searchRepository(root, query, { limit: args.limit })
          : await inspectCodebase(root, query, { limit: args.limit });
        return asText(result);
      }
      if (name === "ensure_capability") {
        const query = String(args.query || "").trim();
        if (!query) throw new Error("query is required");
        const existingSearch = await searchEnabledChildTools(
          visibleRegistry(await loadRegistry(), context).filter((server) => server.enabled && server.id !== "registry-autobroker"),
          query,
          20,
          context,
        );
        if (existingSearch.tools.length) return asText({ ok: true, source: "existing", query, tools: existingSearch.tools, errors: existingSearch.errors });

        const searchResult = await callChild("registry-autobroker", "search_registry", {
          query,
          limit: Math.max(1, Math.min(Number(args.registry_limit || 8), 25)),
          installable_only: true,
        });
        const search = childResultJson(searchResult);
        const candidates = (search.results || []).filter((candidate) => !["deleted", "deprecated"].includes(String(candidate.status || "").toLowerCase()));
        if (!candidates.length) return asText({ ok: false, source: "official-registry", query, reason: "No supported official registry candidate found", search });
        if (args.auto_provision !== true) return asText({ ok: true, source: "official-registry", query, provisioned: false, candidates });

        const attempts = [];
        for (const candidate of candidates) {
          const provisionResult = await callChild("registry-autobroker", "provision_registry_server", {
            name: candidate.name,
            method: args.method || "auto",
            enable: true,
            probe: true,
          });
          const provision = childResultJson(provisionResult);
          attempts.push({ candidate: candidate.name, provision });
          if (provision.enabled && provision.gatewayId) {
            await loadRegistry(true);
            const installedTools = await childTools(provision.gatewayId, true).catch(() => []);
            return asText({ ok: true, source: "official-registry", query, selected: candidate, provision, tools: installedTools, attempts });
          }
          if ((provision.missingRequiredSecrets || []).length) {
            return asText({ ok: false, source: "official-registry", query, selected: candidate, provision, reason: "Required third-party credentials are missing", attempts });
          }
        }
        return asText({ ok: false, source: "official-registry", query, reason: "Candidates were found but none passed provisioning and MCP probing", attempts });
      }
      if (name === "sync_agent_knowledge") return returnChildResult(await callChild("registry-autobroker", "sync_agent_knowledge", {
        device: args.device || "server",
        project_path: args.project_path,
        clients: args.clients,
      }));
      if (name === "upsert_mcp_server") {
        if (args.kind === "remote" && !args.url) throw new Error("url is required for remote MCP servers");
        if (args.kind === "stdio" && !args.command) throw new Error("command is required for stdio MCP servers");
        const registry = await loadRegistry();
        const existing = registry.findIndex(
          (s) => s.id === args.id && (!context.userId || !s.ownerId || s.ownerId === context.userId),
        );
        const entry = { ...(existing >= 0 ? registry[existing] : {}), ...args, ...(context.userId ? { ownerId: context.userId } : {}) };
        if (existing >= 0) registry[existing] = entry;
        else registry.push(entry);
        await closeChild(args.id);
        await saveRegistry(registry);
        return asText({ ok: true, server: entry });
      }
      if (name === "set_mcp_server_enabled") {
        const registry = await loadRegistry();
        const entry = registry.find(
          (s) => s.id === args.server && (!context.userId || !s.ownerId || s.ownerId === context.userId),
        );
        if (!entry) throw new Error(`Unknown MCP server: ${args.server}`);
        entry.enabled = Boolean(args.enabled);
        await closeChild(args.server);
        await saveRegistry(registry);
        return asText({ ok: true, server: entry.id, enabled: entry.enabled });
      }
      if (name === "web_search") {
        const toolArgs = { query: args.query, numResults: Number(args.num_results || 10) };
        try {
          return asText(await localWebSearch({ query: args.query, numResults: toolArgs.numResults }));
        } catch (localError) {
          try {
            return returnChildResult(await callChild("exa", "web_search_exa", toolArgs));
          } catch (remoteError) {
            return asText({
              ok: false,
              query: args.query,
              source: "none",
              errors: [
                { source: "local-searxng", error: localError.message },
                { source: "exa", error: remoteError.message },
              ],
            });
          }
        }
      }
      if (name === "web_fetch") {
        const toolArgs = { urls: args.urls || [args.url] };
        try {
          const local = await localWebFetch({ urls: toolArgs.urls });
          const successful = local.results?.filter((item) => item.ok) || [];
          const browserRequired = local.results?.filter((item) => item.requiresBrowser) || [];
          // A protected/login result is not an excuse to try stealth bypasses.
          // Surface the routing hint so the agent moves to the owner's persistent
          // Metis browser, where real authenticated state and user-visible actions live.
          if (browserRequired.length) return asText(local);
          if (successful.length === toolArgs.urls.length) return asText(local);
          // Partial static extraction: keep successful local pages and ask Exa only
          // as a public-content fallback for failures. This avoids throwing away
          // the fast local result while keeping web_fetch resilient.
          try {
            const remote = await callChild("exa", "web_fetch_exa", {
              urls: local.results.filter((item) => !item.ok).map((item) => item.url),
            });
            return asText({ ...local, fallback: "exa", exa: remote });
          } catch (remoteError) {
            return asText({ ...local, fallback: "none", fallbackError: remoteError.message });
          }
        } catch (localError) {
          try {
            return returnChildResult(await callChild("exa", "web_fetch_exa", toolArgs));
          } catch (remoteError) {
            return asText({
              ok: false,
              source: "none",
              errors: [
                { source: "local-scrapling-static", error: localError.message },
                { source: "exa", error: remoteError.message },
              ],
            });
          }
        }
      }
      if (["browser_navigate", "browser_snapshot", "browser_screenshot", "browser_click", "browser_type", "browser_press", "browser_scroll", "browser_resize", "browser_tabs", "browser_extract_text", "browser_form_state", "browser_batch", "browser_wait_for", "browser_fill_form", "browser_download", "browser_drag", "browser_hover", "browser_select_option", "browser_upload_file"].includes(name)) {
        const chatId = String(context.chatId || "").trim();
        const userId = String(context.userId || "").trim();
        if (!chatId || !userId) throw new Error(`${name} requires a chat session context`);
        const actionMap = {
          browser_navigate: "navigate", browser_snapshot: "snapshot", browser_screenshot: "screenshot", browser_extract_text: "extract_text", browser_form_state: "form_state",
          browser_batch: "batch", browser_wait_for: "wait_for",
          browser_click: "click", browser_type: "type", browser_press: "press", browser_scroll: "scroll", browser_resize: "resize",
          browser_fill_form: "type", browser_download: "download",
          browser_drag: "drag", browser_hover: "hover", browser_select_option: "select_option", browser_upload_file: "upload_file",
        };
        let action = actionMap[name];
        if (name === "browser_tabs") action = args.action === "new" ? "new_tab" : args.action === "close" ? "close_tab" : args.action === "select" ? "select_tab" : "screenshot";
        const batchSteps = Array.isArray(args.steps)
          ? args.steps.slice(0, 100).map((step) => ({
              action: step.action,
              selector: step.selector,
              text: step.text,
              key: step.key,
              value: step.value,
              deltaY: step.delta_y,
              exact: step.exact,
              timeoutMs: step.timeout_ms,
              frame: step.frame,
            }))
          : undefined;
        const payload = {
          action,
          tabId: args.tab_id,
          url: args.url,
          selector: args.selector,
          text: args.text,
          key: args.key,
          value: args.value,
          targetSelector: args.target_selector,
          filePath: args.file_path,
          exact: args.exact,
          timeoutMs: args.timeout_ms,
          includeSnapshot: Boolean(args.include_snapshot),
          frame: args.frame,
          // Programmatic agent actions do not need a JPEG on every mutation.
          // browser_screenshot remains the explicit visual-inspection path.
          includeScreenshot: name === "browser_screenshot",
          steps: batchSteps,
          x: args.x,
          y: args.y,
          deltaY: args.delta_y,
          width: args.width,
          height: args.height,
          downloadPath: currentWorkspace() || ROOT,
        };
        const response = await fetch(INTERNAL_BROWSER_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${String(process.env.MCP_BEARER_TOKEN || "").trim()}`,
            "X-AI-Chat-Internal": "1",
            "X-AI-Chat-Id": chatId,
            "X-AI-Chat-User-Id": userId,
            "X-Chat-Password": String(process.env.CHAT_PASSWORD || ""),
          },
          body: JSON.stringify(payload),
          // Bounded wait: a hung browser engine must fail fast instead of
          // blocking the tool call (and everything queued behind it) forever.
          signal: AbortSignal.timeout(Number(env("MCP_BROWSER_FETCH_TIMEOUT_MS", "180000"))),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Browser action failed (${response.status})`);
        if (data.screenshot) {
          const { screenshot, ...metadata } = data;
          return { content: [{ type: "text", text: JSON.stringify(metadata, null, 2) }, { type: "image", data: screenshot, mimeType: "image/jpeg" }] };
        }
        return asText(data);
      }
      if (name === "context7_resolve") return returnChildResult(await callChild("context7", "resolve-library-id", { libraryName: args.library_name, query: args.query }));
      if (name === "context7_query") return returnChildResult(await callChild("context7", "query-docs", { libraryId: args.library_id, query: args.query }));
      if (name === "system_info") {
        if (args.target === "pc") {
          return asText(await runShell({ target: "pc", timeout: 30, command: `whoami; hostname; Get-ComputerInfo | Select-Object WindowsProductName,WindowsVersion,OsBuildNumber,CsTotalPhysicalMemory,CsProcessors | ConvertTo-Json -Depth 4; Get-PSDrive C | Select-Object Used,Free | ConvertTo-Json` }));
        }
        return asText(await runShell({ target: args.target, timeout: 30, command: `echo '---IDENTITY---'; hostname; whoami; echo '---OS---'; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -a; echo '---UPTIME---'; uptime; echo '---MEMORY---'; free -h; echo '---DISK---'; df -h /; echo '---CPU---'; nproc; grep -m1 'model name' /proc/cpuinfo || true` }));
      }
      if (name === "execute_command") {
        await assertSharedBrowserCommand(args, context);
        return asText(await runShell(args));
      }
      if (name === "verify_work") {
        const { claims, errors } = normalizeClaims(args.claims);
        if (errors.length) throw new Error("Invalid claims: " + errors.join("; "));
        if (!claims.length) throw new Error("verify_work requires at least one claim");
        const results = [];
        for (const claim of claims) {
          let result;
          try {
            result = await runShell({
              target: claim.target,
              command: claim.command,
              timeout: claim.timeout,
              cwd: undefined,
            });
          } catch (error) {
            result = { ok: false, exitCode: null, stdout: "", stderr: String(error?.message || error) };
          }
          results.push(evaluateClaim(claim, result));
        }
        recordVerified(undefined, context, results);
        return asText({ ...compactReport(results), results });
      }
      if (name === "ledger_review") {
        return asText(ledgerSummary(context));
      }
      if (name === "audio_fingerprint") {
        const action = String(args.action || "").trim();
        const script = path.join(ROOT, "scripts", "audio-fingerprint.py");
        if (!["match", "ingest", "stats"].includes(action)) {
          throw new Error("action must be match, ingest, or stats");
        }
        let audio = typeof args.audio === "string" ? args.audio.trim() : "";
        if (action !== "stats" && !audio) throw new Error("audio is required for match/ingest");
        let audioArg = audio;
        let cleanupUrl = null;
        if (/^https?:\/\//i.test(audio)) {
          const stamp = Date.now();
          const tempPath = path.join(os.tmpdir(), `metis-fp-${stamp}-${path.basename(new URL(audio).pathname) || "audio"}`);
          const response = await fetch(audio, { signal: AbortSignal.timeout(60_000) });
          if (!response.ok) throw new Error(`Failed to download audio (${response.status})`);
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > 50 * 1024 * 1024) throw new Error("Audio exceeds 50MB limit");
          await fs.writeFile(tempPath, bytes);
          audioArg = tempPath;
          cleanupUrl = tempPath;
        }
        try {
          const commandParts = ["python3", JSON.stringify(script)];
          commandParts.push(action);
          if (audioArg) commandParts.push(JSON.stringify(audioArg));
          if (action === "ingest") {
            if (!args.title) throw new Error("title is required for ingest");
            commandParts.push("--title", JSON.stringify(String(args.title).slice(0, 200)));
            if (args.artist) commandParts.push("--artist", JSON.stringify(String(args.artist).slice(0, 200)));
            if (args.source) commandParts.push("--source", JSON.stringify(String(args.source).slice(0, 500)));
          }
          const shellResult = await runShell({
            target: "server",
            command: commandParts.join(" "),
            timeout: 240,
          });
          // runShell returns text; the script emits one JSON line per outcome
          const textOut = `${shellResult.stdout || ""}\n${shellResult.stderr || ""}`.trim();
          let payload = null;
          for (const line of textOut.split("\n").reverse()) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("{")) continue;
            try { payload = JSON.parse(trimmed); break; } catch { /* keep scanning */ }
          }
          if (!payload) throw new Error(`fingerprint script failed: ${textOut.slice(0, 400)}`);
          if (payload.ok === false) throw new Error(payload.error || "fingerprint operation failed");
          return asText(payload);
        } finally {
          if (cleanupUrl) await fs.rm(cleanupUrl, { force: true }).catch(() => {});
        }
      }
      if (name === "list_directory") {
        if (args.target === "pc") return asText(await runShell({ target: "pc", timeout: 60, command: `Get-ChildItem -Force -LiteralPath ${psq(args.path)} | Select-Object Mode,Length,LastWriteTime,Name,FullName | ConvertTo-Json -Depth 3` }));
        return asText(await runShell({ target: args.target, timeout: 60, command: `ls -la --time-style=long-iso ${q(args.path)}` }));
      }
      if (name === "read_file") {
        const offset = Math.max(1, Number(args.offset || 1));
        const limit = Math.max(1, Math.min(Number(args.limit || 200), 5000));
        if (args.target === "pc") return asText(await runShell({ target: "pc", timeout: 60, command: `$lines=Get-Content -LiteralPath ${psq(args.path)}; $start=${offset - 1}; $end=[Math]::Min($lines.Count-1,$start+${limit - 1}); if($start -lt $lines.Count){for($i=$start;$i -le $end;$i++){('{0,6}|{1}' -f ($i+1),$lines[$i])}}` }));
        return asText(await runShell({ target: args.target, timeout: 60, command: `nl -ba ${q(args.path)} | sed -n ${q(`${offset},${offset + limit - 1}p`)}` }));
      }
      if (name === "write_file") {
        const b64 = Buffer.from(String(args.content || ""), "utf8").toString("base64");
        if (args.target === "pc") return asText(await runShell({ target: "pc", timeout: 60, command: `[IO.File]::WriteAllBytes(${psq(args.path)},[Convert]::FromBase64String(${psq(b64)})); 'WROTE ${args.path}'` }));
        return asText(await runShell({ target: args.target, timeout: 60, command: `printf %s ${q(b64)} | base64 -d > ${q(args.path)} && echo WROTE:${q(args.path)}` }));
      }
      if (name === "edit_file") {
        const filePath = String(args.path || "");
        const oldText = String(args.oldText ?? "");
        const newText = String(args.newText ?? "");
        if (!filePath) throw new Error("path is required");
        if (!oldText) throw new Error("oldText is required");
        const target = String(args.target || "server");
        if (target === "server" || target === "local") {
          const resolved = path.isAbsolute(filePath)
            ? filePath
            : path.join(currentWorkspace() || ROOT, filePath);
          const content = await fs.readFile(resolved, "utf8");
          const first = content.indexOf(oldText);
          if (first < 0) throw new Error("oldText was not found");
          if (content.indexOf(oldText, first + oldText.length) >= 0) {
            throw new Error("oldText is not unique in the file; pass a smaller unique snippet");
          }
          const next = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
          await fs.writeFile(resolved, next);
          return asText({ path: resolved, replacements: 1, bytes: Buffer.byteLength(next, "utf8") });
        }
        const oldB64 = Buffer.from(oldText, "utf8").toString("base64");
        const newB64 = Buffer.from(newText, "utf8").toString("base64");
        if (target === "pc") {
          return asText(await runShell({
            target: "pc",
            timeout: 60,
            command: `$p=${psq(filePath)};$c=[IO.File]::ReadAllText($p);$o=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psq(oldB64)}));$n=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psq(newB64)}));$i=$c.IndexOf($o);if($i -lt 0){throw 'oldText was not found'};if($c.IndexOf($o,$i+$o.Length) -ge 0){throw 'oldText is not unique'};[IO.File]::WriteAllText($p,$c.Substring(0,$i)+$n+$c.Substring($i+$o.Length));'EDITED '+$p`,
          }));
        }
        return asText(await runShell({
          target,
          timeout: 60,
          command: `python3 -c "import pathlib,base64;p=pathlib.Path(${JSON.stringify(filePath)});c=p.read_text();o=base64.b64decode(${JSON.stringify(oldB64)}).decode();n=base64.b64decode(${JSON.stringify(newB64)}).decode();i=c.find(o);assert i>=0,'oldText was not found';assert c.find(o,i+len(o))<0,'oldText is not unique';p.write_text(c[:i]+n+c[i+len(o):]);print('EDITED',p)"`,
        }));
      }
      if (name === "docker_ps") return asText(await runShell({ target: args.target, timeout: 30, command: `docker ps ${args.all === false ? "" : "-a"}` }));
      if (name === "service_control") {
        if (args.target === "pc") throw new Error("service_control is for Linux systemd devices");
        const prefix = args.user_service ? "systemctl --user" : "sudo -n systemctl";
        const readPrefix = args.user_service ? "systemctl --user" : "systemctl";
        let command;
        if (args.action === "status") command = `${readPrefix} status ${q(args.service)} --no-pager -l`;
        else if (args.action === "logs") command = `journalctl ${args.user_service ? "--user " : ""}-u ${q(args.service)} -n ${Math.max(10, Math.min(Number(args.lines || 150), 2000))} --no-pager`;
        else command = `${prefix} ${args.action} ${q(args.service)} && ${readPrefix} status ${q(args.service)} --no-pager -l`;
        return asText(await runShell({ target: args.target, timeout: 120, command }));
      }
      if (name === "windows_ui") {
        const command = ["winapp", "ui", String(args.action)];
        if (args.selector !== undefined) command.push(String(args.selector));
        if (args.second !== undefined) command.push(String(args.second));
        if (args.app) command.push("-a", String(args.app));
        if (args.window) command.push("-w", String(args.window));
        command.push(...(args.extra_args || []).map(String));
        if (!command.includes("--json") && !["invoke", "click", "set-value", "send-keys", "focus", "hover", "drag", "touch", "pen", "scroll", "scroll-into-view"].includes(args.action)) command.push("--json");
        return asText(await runWindowsJob({ action: "run", command, timeout: clampTimeout(args.timeout || 120, 3600), cwd: HOSTS.pc.home }));
      }
      if (name === "windows_screenshot") {
        const command = ["winapp", "ui", "screenshot", String(args.selector || "window")];
        if (args.app) command.push("-a", String(args.app));
        if (args.window) command.push("-w", String(args.window));
        if (args.capture_screen) command.push("--capture-screen");
        command.push("--json");
        const result = await runWindowsJob({ action: "run", command, timeout: 120, cwd: HOSTS.pc.home });
        let parsed;
        try { parsed = JSON.parse(result.stdout); } catch { parsed = result.stdout; }
        const serialized = JSON.stringify(parsed);
        const match = serialized.match(/[A-Za-z]:\\\\[^\"']+?\.png/);
        if (!match) return asText({ result, warning: "Screenshot completed but no PNG path was found." });
        const winPath = match[0].replaceAll("\\\\", "\\");
        const imageRead = await runWindowsPowerShell(`[Convert]::ToBase64String([IO.File]::ReadAllBytes(${psq(winPath)}))`, 60);
        if (imageRead.exit_code !== 0) return asText({ result, warning: imageRead.stderr });
        return { content: [{ type: "text", text: JSON.stringify({ screenshot: winPath, command_result: result }, null, 2) }, { type: "image", data: imageRead.stdout.trim(), mimeType: "image/png" }] };
      }
      if (name === "electron_test") {
        const project = String(args.project_path);
        const timeout = clampTimeout(args.timeout || 1800, 3600);
        if (args.action === "launch") {
          const command = args.command ? String(args.command) : "npm start";
          return asText(await runWindowsJob({ action: "spawn", command, cwd: project, timeout: 60 }));
        }
        if (args.command) return asText(await runWindowsJob({ action: "run", command: String(args.command), cwd: project, timeout }));
        const script = `$ErrorActionPreference='Continue'; $pkg=Get-Content -Raw package.json | ConvertFrom-Json; function Has([string]$n){return $null -ne $pkg.scripts.$n}; function RunStep([string]$n,[scriptblock]$b){Write-Output ('===== '+$n+' ====='); & $b; Write-Output ('EXIT='+$LASTEXITCODE)}; switch(${psq(args.action)}) { 'analyze' { [pscustomobject]@{name=$pkg.name;version=$pkg.version;main=$pkg.main;scripts=$pkg.scripts;dependencies=$pkg.dependencies;devDependencies=$pkg.devDependencies;node=(node --version);npm=(npm --version);git=(git status --short)} | ConvertTo-Json -Depth 8 } 'install' { if(Test-Path package-lock.json){npm ci}else{npm install} } 'audit' { npm audit --audit-level=moderate } 'lint' { if(Has 'lint'){npm run lint}else{Write-Output 'NO_LINT_SCRIPT'} } 'typecheck' { if(Has 'typecheck'){npm run typecheck}elseif(Has 'check'){npm run check}else{npx tsc --noEmit} } 'unit' { if(Has 'test:unit'){npm run test:unit}elseif(Has 'test'){npm test}else{Write-Output 'NO_UNIT_TEST_SCRIPT'} } 'e2e' { if(Has 'test:e2e'){npm run test:e2e}elseif(Has 'e2e'){npm run e2e}else{npx playwright test} } 'build' { if(Has 'build'){npm run build}elseif(Has 'compile'){npm run compile}else{Write-Output 'NO_BUILD_SCRIPT'} } 'package' { if(Has 'make'){npm run make}elseif(Has 'package'){npm run package}elseif(Has 'dist'){npm run dist}else{Write-Output 'NO_PACKAGE_SCRIPT'} } 'full' { if(Test-Path package-lock.json){RunStep 'INSTALL' {npm ci}}else{RunStep 'INSTALL' {npm install}}; RunStep 'AUDIT' {npm audit --audit-level=moderate}; if(Has 'lint'){RunStep 'LINT' {npm run lint}}; if(Has 'typecheck'){RunStep 'TYPECHECK' {npm run typecheck}}elseif(Has 'check'){RunStep 'CHECK' {npm run check}}; if(Has 'test:unit'){RunStep 'UNIT' {npm run test:unit}}elseif(Has 'test'){RunStep 'UNIT' {npm test}}; if(Has 'test:e2e'){RunStep 'E2E' {npm run test:e2e}}elseif(Has 'e2e'){RunStep 'E2E' {npm run e2e}}; if(Has 'build'){RunStep 'BUILD' {npm run build}}; if(Has 'make'){RunStep 'PACKAGE' {npm run make}}elseif(Has 'package'){RunStep 'PACKAGE' {npm run package}}elseif(Has 'dist'){RunStep 'PACKAGE' {npm run dist}} } }`;
        return asText(await runWindowsJob({ action: "run", command: ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], cwd: project, timeout }));
      }
      if (name === "windows_desktop_job") return asText(await runWindowsJob({ action: args.action || "run", command: args.command, cwd: args.cwd || HOSTS.pc.home, timeout: clampTimeout(args.timeout || 600, 3600), env: args.env || {} }));

      // ─── Registry / Bootstrap passthrough tools ───

      if (name === "workflow_save") return asText({ ok: true, workflow: await workflowStore.save(args, Boolean(args.overwrite)) });
      if (name === "workflow_list") return asText({ workflows: await workflowStore.list() });
      if (name === "workflow_get") return asText(await workflowStore.get(args.name));
      if (name === "workflow_delete") return asText(await workflowStore.delete(args.name));
      if (name === "workflow_run") {
        const workflow = await workflowStore.get(args.name);
        return asText(await runWorkflow(workflow, {
          dryRun: Boolean(args.dry_run),
          execute: async (tool, toolArgs) => {
            const result = await dispatchGatewayTool(tool, toolArgs, { context });
            const text = childResultText(result);
            if (result?.isError) throw new Error(text || `Tool ${tool} failed`);
            try {
              const parsed = JSON.parse(text);
              if (parsed?.exit_code !== undefined && parsed.exit_code !== 0) throw new Error(`Tool ${tool} exited with code ${parsed.exit_code}`);
              if (parsed?.ok === false) throw new Error(parsed.error || `Tool ${tool} reported failure`);
            } catch (error) {
              if (error instanceof SyntaxError) { /* Non-JSON output can still be successful. */ }
              else throw error;
            }
            return text;
          },
        }));
      }
      if (name === "assistant_status") {
        const checks = await Promise.all(Object.keys(HOSTS).map(async (target) => {
          const result = await runShell({ target, timeout: 12, command: target === "pc" ? "hostname" : "hostname" });
          return [target, { online: result.exit_code === 0, latency_ms: result.duration_ms, host: result.exit_code === 0 ? result.stdout.trim().slice(0, 80) : undefined }];
        }));
        const serviceNames = ["metis-ai", "metis-ai-worker", "metis-ai-remote-client", "mcp-universal", "mcp-router", "mcp-ssh-proxy"];
        const serviceResult = await runShell({ target: "server", timeout: 12, command: `for s in ${serviceNames.map(q).join(" ")}; do printf '%s=' "$s"; systemctl is-active "$s" 2>/dev/null || systemctl --user is-active "$s" 2>/dev/null || true; done` });
        const services = Object.fromEntries(serviceResult.stdout.trim().split(/\n/).filter(Boolean).map((line) => { const [service, status] = line.split("="); return [service, status || "unknown"]; }));
        return asText({ at: new Date().toISOString(), devices: Object.fromEntries(checks), services, tool_count: tools.length });
      }

      if (name === "gateway_bootstrap") {
        return asText({
          name: `${APP_NAME} Universal MCP`,
          transport: "streamable-http",
          legacy_endpoint: `${PUBLIC_URL}/mcp`,
          universal_endpoint: `${PUBLIC_URL}/all`,
          authentication: { tailscale: true, bearer_supported: true },
          discovery: { status: "gateway_status", search: "search_tools", ensure: "ensure_capability", invoke: "call_mcp_tool" },
        });
      }

      if (name === "search_registry") {
        return returnChildResult(await callChild("registry-autobroker", "search_registry", {
          query: args.query, limit: args.limit, installable_only: args.installable_only,
        }));
      }
      if (name === "registry_status") {
        return returnChildResult(await callChild("registry-autobroker", "registry_status", {}));
      }
      if (name === "registry_changes") {
        return returnChildResult(await callChild("registry-autobroker", "registry_changes", {
          since: args.since, limit: args.limit,
        }));
      }
      if (name === "provision_registry_server") {
        return returnChildResult(await callChild("registry-autobroker", "provision_registry_server", {
          name: args.name, method: args.method, enable: args.enable, probe: args.probe,
        }));
      }
      if (name === "test_mcp_server") {
        const serverId = String(args.server);
        try {
          const toolList = await childTools(serverId, true);
          return asText({ ok: true, server: serverId, toolCount: toolList.length, tools: toolList.map(t => ({ name: t.name, description: t.description })) });
        } catch (err) {
          return asText({ ok: false, server: serverId, error: err.message });
        }
      }
      if (name === "sync_project_rules") {
        const projectsPath = path.join(STATE_DIR, "autobroker", "projects.json");
        const config = JSON.parse(await fs.readFile(projectsPath, "utf8").catch(() => '{"targets":[]}'));
        const target = { device: args.device || "server", projectPath: args.project_path, clients: args.clients || ["agents","claude","gemini","copilot","cursor","opencode"] };
        const existing = config.targets.findIndex(t => t.device === target.device && t.projectPath === target.projectPath);
        if (existing >= 0) config.targets[existing] = target; else config.targets.push(target);
        await fs.writeFile(projectsPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
        return asText({ ok: true, registered: target, totalTargets: config.targets.length });
      }
      if (name === "get_catalog_version") {
        const catalogPath = path.join(STATE_DIR, "autobroker", "catalog.json");
        const statePath = path.join(STATE_DIR, "autobroker", "state.json");
        const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
        const state = JSON.parse(await fs.readFile(statePath, "utf8").catch(() => "{}"));
        return asText({ catalogVersion: catalog.version, generatedAt: catalog.generatedAt, total: catalog.total, lastSync: state.lastSuccessfulSync, pages: state.pages });
      }
      if (name === "get_catalog_changes") {
        return returnChildResult(await callChild("registry-autobroker", "registry_changes", {
          since: args.since, limit: args.limit || 50,
        }));
      }
      if (name === "get_connection_instructions") {
        const token = (await fs.readFile(path.join(STATE_DIR, "token"), "utf8").catch(() => "")).trim();
        const allClients = {
          "claude": { name: "Claude Code", config: { type: "url", url: `${PUBLIC_URL}/all`, transport: "http", headers: { Authorization: `Bearer ${token}` } } },
          "codex": { name: "OpenAI Codex CLI", config: { mcpServers: { "ai-chat-universal": { type: "streamable-http", url: `${PUBLIC_URL}/all`, headers: { Authorization: `Bearer ${token}` } } } } },
          "hermes": { name: "Hermes Agent", config: { type: "streamable-http", url: `${PUBLIC_URL}/all`, headers: { Authorization: `Bearer ${token}` } } },
          "gemini": { name: "Gemini CLI", config: { mcpServers: { "ai-chat-universal": { url: `${PUBLIC_URL}/all`, transport: "streamable-http", headers: { Authorization: `Bearer ${token}` } } } } },
          "opencode": { name: "OpenCode", config: { mcp: { "ai-chat-universal": { type: "streamable-http", url: `${PUBLIC_URL}/all`, headers: { Authorization: `Bearer ${token}` } } } } },
          "cursor": { name: "Cursor", config: { mcpServers: { "ai-chat-universal": { url: `${PUBLIC_URL}/all`, transport: "streamable-http", headers: { Authorization: `Bearer ${token}` } } } } },
        };
        if (args.client) {
          const key = String(args.client).toLowerCase();
          return asText(args.client in allClients ? { [key]: allClients[key] } : { error: `Unknown client: ${args.client}`, available: Object.keys(allClients) });
        }
        return asText(allClients);
      }

      return asText({ error: `Unknown tool: ${name}` });
    } catch (err) {
      await audit(name, args, `error:${err.message}`);
      return { isError: true, content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function trustedSessionContextFromBearer(rawToken) {
  const claims = verifyTrustedMcpSession(
    rawToken,
    String(process.env.MCP_BEARER_TOKEN || "").trim(),
  );
  if (!claims) return null;
  // Only explicitly allowed fields survive the authentication boundary.
  return {
    transport: "http",
    trustedInternal: true,
    chatId: typeof claims.chatId === "string" ? claims.chatId : undefined,
    userId: claims.userId,
    jobId: typeof claims.jobId === "string" ? claims.jobId : undefined,
    workerId: typeof claims.workerId === "string" ? claims.workerId : undefined,
    leaseToken: typeof claims.leaseToken === "string" ? claims.leaseToken : undefined,
    incognito: claims.incognito === true,
    automation: claims.automation === true,
    modeId: typeof claims.modeId === "string" ? claims.modeId : undefined,
    runtimeMode: typeof claims.runtimeMode === "string" ? claims.runtimeMode : undefined,
    modePolicy: typeof claims.modePolicy === "string" ? claims.modePolicy : undefined,
    compressionEnabled: claims.compressionEnabled === true,
    compressionMode: typeof claims.compressionMode === "string" ? claims.compressionMode : undefined,
    compressionToolResults: typeof claims.compressionToolResults === "boolean" ? claims.compressionToolResults : undefined,
    capabilityManifest: typeof claims.capabilityManifest === "string" ? claims.capabilityManifest : undefined,
    capabilityHash: typeof claims.capabilityHash === "string" ? claims.capabilityHash : undefined,
    osUsername: typeof claims.osUsername === "string" ? claims.osUsername : "",
    uid: claims.uid,
    gid: claims.gid,
    workspaceRoot: claims.workspaceRoot,
    home: claims.home,
    allowRoot: claims.allowRoot === true,
    isHostAdmin: claims.isHostAdmin === true,
  };
}

function requestAuthorization(req) {
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const trustedContext = trustedSessionContextFromBearer(supplied);
  if (trustedContext) return { ok: true, trustedContext };

  // A native Metis session token must never silently downgrade to anonymous
  // localhost access. If its signature, expiry, or claims are invalid, fail
  // closed so the runtime gets an actionable authentication error instead of
  // losing chat/user/mode context and producing misleading tool failures.
  if (supplied.startsWith("metis-v1.")) {
    return { ok: false, trustedContext: null };
  }

  const configured = String(process.env.MCP_BEARER_TOKEN || "").trim();
  if (supplied) {
    return { ok: safeEqualText(configured, supplied), trustedContext: null };
  }

  const address = String(req.socket?.remoteAddress || "").replace(/^::ffff:/i, "");
  if (address === "127.0.0.1" || address === "::1" || address === "localhost") {
    return { ok: true, trustedContext: null };
  }
  return { ok: false, trustedContext: null };
}

function authorized(req) {
  return requestAuthorization(req).ok;
}

async function main() {
  await ensureState();
  const transports = {};
  const httpServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Session-Id, MCP-Protocol-Version");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: `${APP_NAME} Universal MCP Gateway`, version: "4.0.0", endpoint: "/mcp" }));
      return;
    }
    const auth = requestAuthorization(req);
    if (!auth.ok) {
      res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (url.pathname === "/registry" && req.method === "GET") {
      const registry = await loadRegistry();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(registry.map(({ env, headers, ...entry }) => ({ ...entry, envKeys: Object.keys(env || {}), headerKeys: Object.keys(headers || {}) })), null, 2));
      return;
    }
    if (url.pathname !== "/mcp" && url.pathname !== "/all" && url.pathname !== "/") { res.writeHead(404); res.end("Not Found"); return; }
    const sessionId = req.headers["mcp-session-id"];
    try {
      if (sessionId && transports[sessionId]) {
        await transports[sessionId].handleRequest(req, res);
        return;
      }
      if (!sessionId && req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body || "{}");
        if (!isInitializeRequest(parsed)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session. Send initialize first." }, id: parsed.id ?? null }));
          return;
        }
        const sessionServer = createServerForSession(
          auth.trustedContext || { transport: "http" },
        );
        let transport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => { transports[sid] = transport; console.log(`[mcp] session ${sid} initialized`); },
        });
        transport.onclose = () => { const sid = transport.sessionId; if (sid) delete transports[sid]; };
        await sessionServer.connect(transport);
        await transport.handleRequest(req, res, parsed);
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request" }, id: null }));
    } catch (err) {
      console.error("[mcp] request error", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: err.message || "Internal error" }, id: null }));
      }
    }
  });
  httpServer.listen(PORT, "127.0.0.1", () => console.log(`[mcp] ${APP_NAME} Universal MCP Gateway listening on http://127.0.0.1:${PORT}/mcp`));
  httpServer.on("error", (err) => {
    const code = err && typeof err === "object" && "code" in err ? err.code : "";
    if (code === "EADDRINUSE") {
      console.error(`[mcp] Port ${PORT} is already in use. Set MCP_PORT to a free port (for example 8798).`);
    } else {
      console.error("[mcp] listen error", err);
    }
    process.exit(1);
  });
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

function compressGatewayText(value, mode = "stacked") {
  let text = String(value ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  if (mode === "rtk" || mode === "stacked") {
    const lines = text.split(/\r?\n/);
    const output = [];
    let previous = "";
    let repeats = 0;
    for (const line of lines) {
      const trimmed = line.replace(/[ \t]+$/g, "");
      const normalized = trimmed.trim();
      if (/^(?:progress|downloading|installing)\b.*(?:\d+%|\|)/i.test(normalized)) continue;
      if (normalized && normalized === previous && ++repeats > 1 && !/\b(error|fail|warning|exception)\b/i.test(normalized)) continue;
      if (normalized !== previous) repeats = 0;
      if (normalized) previous = normalized;
      output.push(trimmed);
    }
    text = output.join("\n").replace(/\n{3,}/g, "\n\n");
  }
  if (mode !== "rtk") {
    text = text
      .replace(/\bplease\s+/gi, "")
      .replace(/\bin order to\b/gi, "to")
      .replace(/\bdue to the fact that\b/gi, "because")
      .replace(/\bcurrently\b/gi, "now")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n");
  }
  return text;
}

function compressGatewayResult(result, context) {
  if (!context?.compressionEnabled || context?.compressionToolResults === false || context?.incognito || !result || typeof result !== "object") return result;
  const mode = context.compressionMode || "stacked";
  if (!Array.isArray(result.content)) return result;
  return {
    ...result,
    content: result.content.map((item) =>
      item?.type === "text" && typeof item.text === "string"
        ? { ...item, text: compressGatewayText(item.text, mode) }
        : item,
    ),
  };
}

async function dispatchGatewayToolCompressed(name, args = {}, options = {}) {
  const result = await dispatchGatewayTool(name, args, options);
  return compressGatewayResult(result, options.context || {});
}

export {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Server,
  StdioServerTransport,
  childCacheKey,
  modeToolCategory,
  runtimeModeRequiresApproval,
  shouldAutoApprove,
  tools,
  visibleToolsForContext,
  dispatchGatewayToolCompressed as dispatchGatewayTool,
};

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((err) => { console.error("Fatal", err); process.exit(1); });
}
