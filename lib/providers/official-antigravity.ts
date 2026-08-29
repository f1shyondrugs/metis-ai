import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import { config } from "@/lib/config";
import { updateOAuthFlow } from "@/lib/oauth-flows";
import { updateProviderConnection } from "@/lib/provider-connections";
import { waitForOAuthManualCode } from "@/lib/providers/oauth";
import { classifyTranscriptTool } from "@/lib/agent-transcript";
import { todosFromToolPayload } from "@/lib/tool-call-display";
import type { McpServerMap } from "@/lib/mcp";
import type { ToolPart } from "@/lib/store";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function antigravitySupportsEffort(modelId: string) {
  return /^(?:gemini|gpt-oss)(?:[-_.]|$)/i.test(modelId.trim());
}

function stripTerminalControl(value: string) {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

export function antigravityMcpConfig(mcp: McpServerMap) {
  return {
    mcpServers: Object.fromEntries(
      Object.entries(mcp).map(([id, server]) => [
        id,
        server.type === "http"
          ? {
              disabled: false,
              serverUrl: server.url,
              ...(server.headers ? { headers: server.headers } : {}),
            }
          : {
              disabled: false,
              command: server.command,
              args: server.args,
              env: server.env,
            },
      ]),
    ),
  };
}

export type AntigravitySdkMcpServer =
  | { name: string; type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { name: string; type: "http"; url: string; headers?: Record<string, string> };

export function antigravitySdkMcpServers(mcp: McpServerMap = {}): AntigravitySdkMcpServer[] {
  return Object.entries(mcp).map(([name, server]) =>
    server.type === "http"
      ? {
          name,
          type: "http" as const,
          url: server.url,
          ...(server.headers ? { headers: server.headers } : {}),
        }
      : {
          name,
          type: "stdio" as const,
          command: server.command,
          args: server.args,
          env: server.env,
        },
  );
}

export function antigravityCliSettings() {
  return {
    enableTelemetry: false,
    toolPermission: "always-proceed",
  };
}

export async function writeAntigravitySessionFiles(tempHome: string, mcp?: McpServerMap) {
  const geminiConfig = path.join(tempHome, ".gemini", "config");
  const cliDir = path.join(tempHome, ".gemini", "antigravity-cli");
  await mkdir(geminiConfig, { recursive: true, mode: 0o700 });
  await mkdir(cliDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(cliDir, "settings.json"),
    `${JSON.stringify(antigravityCliSettings(), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  if (!mcp) return;
  const payload = `${JSON.stringify(antigravityMcpConfig(mcp), null, 2)}\n`;
  await writeFile(path.join(geminiConfig, "mcp_config.json"), payload, { encoding: "utf8", mode: 0o600 });
  await writeFile(path.join(cliDir, "mcp_config.json"), payload, { encoding: "utf8", mode: 0o600 });
}

const TOOL_LINE = /(?:calling|called|using|ran)\s+(?:mcp\s+)?tool[:\s]+[`\"]?([A-Za-z0-9_./-]+)[`\"]?/i;

type AntigravityCliUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export function parseAntigravityCliChunk(chunk: string): {
  text: string;
  tools: ToolPart[];
  conversationId?: string;
  usage?: AntigravityCliUsage;
  error?: string;
} {
  const tools: ToolPart[] = [];
  const textLines: string[] = [];
  let conversationId: string | undefined;
  let usage: AntigravityCliUsage | undefined;
  let error: string | undefined;
  const usageFrom = (value: unknown): AntigravityCliUsage | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const next: AntigravityCliUsage = {};
    if (typeof record.input_tokens === "number") next.inputTokens = record.input_tokens;
    if (typeof record.output_tokens === "number") next.outputTokens = record.output_tokens;
    if (typeof record.total_tokens === "number") next.totalTokens = record.total_tokens;
    return Object.keys(next).length ? next : undefined;
  };
  const mergeUsage = (next?: AntigravityCliUsage) => {
    if (!next) return;
    usage = { ...(usage || {}), ...next };
  };

  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const event = typeof parsed.event === "string" ? parsed.event : "";
      if (event === "init") {
        if (typeof parsed.conversation_id === "string" && parsed.conversation_id) {
          conversationId = parsed.conversation_id;
        }
        continue;
      }
      if (event === "step_update") {
        const update = parsed.step_update && typeof parsed.step_update === "object" && !Array.isArray(parsed.step_update)
          ? parsed.step_update as Record<string, unknown>
          : {};
        if (typeof update.conversation_id === "string" && update.conversation_id) {
          conversationId = update.conversation_id;
        }
        mergeUsage(usageFrom(update.usage));
        const stepType = String(update.step_type || "");
        if (stepType === "agent_response") {
          if (typeof update.text_delta === "string" && update.text_delta) textLines.push(update.text_delta);
          continue;
        }
        if (stepType === "tool") {
          const info = update.tool_info && typeof update.tool_info === "object" && !Array.isArray(update.tool_info)
            ? update.tool_info as Record<string, unknown>
            : {};
          const params = info.parameters && typeof info.parameters === "object" && !Array.isArray(info.parameters)
            ? info.parameters as Record<string, unknown>
            : {};
          const nestedArgs = params.Arguments && typeof params.Arguments === "object" && !Array.isArray(params.Arguments)
            ? params.Arguments as Record<string, unknown>
            : params;
          const name = typeof params.ToolName === "string" && params.ToolName
            ? params.ToolName
            : String(info.name || update.tool_name || "Antigravity tool");
          const input = Object.keys(nestedArgs).length ? JSON.stringify(nestedArgs) : undefined;
          const result = typeof info.output === "string"
            ? info.output
            : info.output !== undefined
              ? JSON.stringify(info.output)
              : typeof (info.error as Record<string, unknown> | undefined)?.message === "string"
                ? String((info.error as Record<string, unknown>).message)
                : undefined;
          const state = String(update.state || "").toUpperCase();
          const status = state === "ACTIVE" ? "running" : state === "ERROR" ? "error" : "completed";
          const todos = todosFromToolPayload(input, result);
          const kind = classifyTranscriptTool(name, input, result);
          const stepIndex = String(update.step_index ?? "tool");
          tools.push({
            id: kind === "todo" ? "todo" : `${conversationId || "antigravity"}:${stepIndex}:${name}`,
            name,
            status,
            kind,
            ...(input ? { input } : {}),
            ...(result ? { result } : {}),
            ...(todos?.length ? { todos } : {}),
          });
          continue;
        }
        continue;
      }
      if (event === "result") {
        const resultRecord = parsed.result && typeof parsed.result === "object" && !Array.isArray(parsed.result)
          ? parsed.result as Record<string, unknown>
          : {};
        if (typeof resultRecord.conversation_id === "string" && resultRecord.conversation_id) {
          conversationId = resultRecord.conversation_id;
        }
        mergeUsage(usageFrom(resultRecord.usage));
        if (String(resultRecord.status || "").toUpperCase() === "ERROR") {
          error = String(resultRecord.error || "Antigravity run failed.");
        }
        continue;
      }
      // Compatibility with older/non-stream Antigravity JSON events.
      if (parsed.type === "tool" || parsed.type === "tool_call" || parsed.type === "mcp_tool_call") {
        const name = String(parsed.name || parsed.toolName || parsed.tool || "Antigravity tool");
        const input = typeof parsed.input === "string" ? parsed.input : parsed.input ? JSON.stringify(parsed.input) : undefined;
        const result = typeof parsed.result === "string" ? parsed.result : undefined;
        const todos = todosFromToolPayload(input, result);
        const kind = classifyTranscriptTool(name, input, result);
        tools.push({
          id: kind === "todo" ? "todo" : String(parsed.id || parsed.toolCallId || crypto.randomUUID()),
          name,
          status: String(parsed.status || "completed"),
          kind,
          ...(input ? { input } : {}),
          ...(result ? { result } : {}),
          ...(todos?.length ? { todos } : {}),
        });
        continue;
      }
    } catch {
      // Plain CLI text below.
    }
    const match = trimmed.match(TOOL_LINE);
    if (match?.[1]) {
      tools.push({
        id: crypto.randomUUID(),
        name: match[1],
        status: "completed",
        kind: classifyTranscriptTool(match[1]),
      });
      continue;
    }
    if (/ERROR: logging before google\.Init/i.test(trimmed)) continue;
    textLines.push(line);
  }
  return { text: textLines.join("\n"), tools, conversationId, usage, error };
}

function findAuthorizationUrl(value: string) {
  const start = value.indexOf("https://accounts.google.com/");
  if (start < 0) return undefined;
  const compact = value.slice(start).replace(/\s+/g, "");
  const queryStart = compact.indexOf("?");
  if (queryStart >= 0) {
    const base = compact.slice(0, queryStart);
    const query = compact.slice(queryStart + 1);
    const names = [
      "client_id",
      "response_type",
      "redirect_uri",
      "scope",
      "code_challenge",
      "code_challenge_method",
      "state",
      "access_type",
      "prompt",
    ];
    const params = new URLSearchParams();
    for (const name of names) {
      const match = query.match(new RegExp(`${name}=([A-Za-z0-9%._~:/+\\-]+)`));
      if (!match?.[1]) continue;
      try {
        const decoded = decodeURIComponent(match[1]);
        if (name === "scope") {
          const scopes = decoded
            .replace(/\+/g, " ")
            .split(/\s+/)
            .filter(Boolean)
            .filter((scope) => scope !== "https://www.googleapis.com/auth/aicode");
          params.set(name, scopes.join(" "));
        } else {
          params.set(name, decoded);
        }
      } catch {
        params.set(name, match[1]);
      }
    }
    if (params.get("response_type") && params.get("client_id") && params.get("state")) {
      return `${base}?${params.toString()}`;
    }
  }
  const match = value.match(/https:\/\/accounts\.google\.com\/[^\s"'<>]+/);
  const candidate = match?.[0]?.replace(/[),.;]+$/, "");
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    if (
      parsed.searchParams.get("response_type") &&
      parsed.searchParams.get("client_id") &&
      parsed.searchParams.get("state")
    ) {
      return parsed.toString();
    }
  } catch {
    // Wait for the next PTY chunk to complete the URL.
  }
  return undefined;
}

function normalizeCode(value: string) {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    return parsed.searchParams.get("code")?.trim() || trimmed;
  } catch {
    return trimmed;
  }
}

function officialAgyPath() {
  return (
    process.env.AGY_CLI_PATH?.trim() ||
    path.join(os.homedir(), ".local", "bin", "agy") ||
    "agy"
  );
}

function isAuthTokenFile(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const token = (value as { token?: unknown }).token;
  return Boolean(
    token &&
      typeof token === "object" &&
      typeof (token as { access_token?: unknown }).access_token === "string",
  );
}

export async function runOfficialAntigravityOAuthFlow(input: {
  flowId: string;
  ownerId: string;
}) {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "ai-chat-agy-"));
  const tokenFile = path.join(
    tempHome,
    ".gemini",
    "antigravity-cli",
    "antigravity-oauth-token",
  );
  const command = officialAgyPath();
  if (command !== "agy" && !existsSync(command)) {
    throw new Error(`Official Antigravity CLI was not found at ${command}.`);
  }

  const environment = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    XDG_CONFIG_HOME: path.join(tempHome, ".config"),
    XDG_CACHE_HOME: path.join(tempHome, ".cache"),
    PATH: `${path.dirname(command)}:${process.env.PATH || ""}`,
    TERM: "xterm-256color",
    SSH_CONNECTION: "198.51.100.10 50000 198.51.100.20 22",
    SSH_CLIENT: "198.51.100.10 50000 22",
    SSH_TTY: "/dev/pts/0",
  };

  const terminal = pty.spawn(command, ["-i", "Authenticate this Antigravity session."], {
    name: "xterm-256color",
    cols: 1000,
    rows: 50,
    cwd: config.agentCwd,
    env: environment as Record<string, string>,
  });
  let output = "";
  let urlSent = false;
  let codeWaiter: Promise<void> | undefined;
  let selectedGoogleOAuth = false;
  let stopped = false;
  let exited = false;
  let exitCode: number | undefined;

  const finish = () => {
    if (stopped) return;
    stopped = true;
    try {
      terminal.kill();
    } catch {
      // The CLI may already have exited.
    }
  };

  const waitForCodeAndSubmit = () => {
    if (codeWaiter) return;
    codeWaiter = waitForOAuthManualCode(input.flowId, input.ownerId)
      .then((value) => {
        terminal.write(`${normalizeCode(value)}\r`);
      })
      .catch((error) => {
        updateOAuthFlow(input.flowId, input.ownerId, {
          status: "error",
          error: error instanceof Error ? error.message : "Antigravity code input failed.",
        });
        finish();
      });
  };

  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit((event) => {
      exited = true;
      exitCode = event.exitCode;
      resolve();
    });
  });

  terminal.onData((chunk) => {
    output = `${output}${stripTerminalControl(chunk)}`.slice(-12_000);
    const url = findAuthorizationUrl(output);
    if (url && !urlSent) {
      urlSent = true;
      updateOAuthFlow(input.flowId, input.ownerId, {
        status: "awaiting_code",
        authUrl: url,
        instructions: "Open the official Antigravity link, finish Google login, then paste the displayed authorization code.",
      });
      waitForCodeAndSubmit();
    }
    if (!selectedGoogleOAuth && /select login method|google oauth/i.test(output)) {
      selectedGoogleOAuth = true;
      terminal.write("1\r");
    }
  });

  const timeout = Date.now() + 10 * 60_000;
  while (Date.now() < timeout && !stopped && !exited) {
    if (existsSync(tokenFile)) {
      try {
        const tokenData = await readFile(tokenFile, "utf8");
        if (isAuthTokenFile(JSON.parse(tokenData))) {
          finish();
          await exitPromise;
          await rm(tempHome, { recursive: true, force: true });
          return tokenData;
        }
      } catch {
        // The CLI may be writing the token file; try again.
      }
    }
    await delay(250);
  }

  finish();
  await exitPromise;
  await rm(tempHome, { recursive: true, force: true });
  if (exited && exitCode !== 0) {
    throw new Error("Official Antigravity CLI exited before completing login.");
  }
  throw new Error("Official Antigravity login timed out.");
}

function safeSessionSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "default";
}

export function antigravitySessionDir(input: { userId: string; connectionId: string; chatId: string }) {
  return path.join(
    config.dataDir,
    "provider-sessions",
    "antigravity",
    safeSessionSegment(input.userId),
    safeSessionSegment(input.connectionId),
    safeSessionSegment(input.chatId),
  );
}

export async function runOfficialAntigravityJob(context: {
  userId: string;
  connectionId: string;
  chatId: string;
  secret: string;
  modelId: string;
  conversationId?: string;
  effort?: string;
  prompt: string;
  cwd?: string;
  mcp?: McpServerMap;
  extraEnv?: Record<string, string>;
  signal: AbortSignal;
  onText: (value: string) => void;
  onStream: (data: Record<string, unknown>) => void;
  onTool?: (tool: ToolPart) => void;
}) {
  const sessionHome = antigravitySessionDir({
    userId: context.userId,
    connectionId: context.connectionId,
    chatId: context.chatId,
  });
  await mkdir(sessionHome, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(
    sessionHome,
    ".gemini",
    "antigravity-cli",
    "antigravity-oauth-token",
  );
  const command = officialAgyPath();
  if (command !== "agy" && !existsSync(command)) {
    throw new Error(`Official Antigravity CLI was not found at ${command}.`);
  }
  await mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  const secretLooksLikeOAuthJson = context.secret.trim().startsWith("{");
  if (secretLooksLikeOAuthJson) {
    await writeFile(tokenFile, context.secret, { encoding: "utf8", mode: 0o600 });
  }
  await writeAntigravitySessionFiles(sessionHome, context.mcp);

  const terminal = pty.spawn(
    command,
    [
      "-p",
      context.prompt,
      "--model",
      context.modelId,
      ...(context.effort ? ["--effort", context.effort] : []),
      ...(context.conversationId === "continue"
        ? ["--continue"]
        : context.conversationId
          ? ["--conversation", context.conversationId]
          : []),
      "--output-format",
      "stream-json",
      "--print-timeout",
      "30m",
    ],
    {
      name: "xterm-256color",
      cols: 1000,
      rows: 50,
      cwd: context.cwd || config.agentCwd,
      env: {
        ...process.env,
        HOME: sessionHome,
        USERPROFILE: sessionHome,
        XDG_CONFIG_HOME: path.join(sessionHome, ".config"),
        XDG_CACHE_HOME: path.join(sessionHome, ".cache"),
        PATH: `${path.dirname(command)}:${process.env.PATH || ""}`,
        TERM: "xterm-256color",
        SSH_CONNECTION: "198.51.100.10 50000 198.51.100.20 22",
        SSH_CLIENT: "198.51.100.10 50000 22",
        SSH_TTY: "/dev/pts/0",
        ...(context.extraEnv || {}),
      } as Record<string, string>,
    },
  );
  let output = "";
  let jsonlBuffer = "";
  let conversationId = context.conversationId === "continue" ? undefined : context.conversationId;
  let usage: AntigravityCliUsage | undefined;
  let cliError = "";
  const handleStructuredOutput = (value: string) => {
    const parsed = parseAntigravityCliChunk(value);
    if (parsed.conversationId) conversationId = parsed.conversationId;
    if (parsed.usage) usage = { ...(usage || {}), ...parsed.usage };
    if (parsed.error) cliError = parsed.error;
    for (const tool of parsed.tools) context.onTool?.(tool);
    if (parsed.text.trim()) context.onText(parsed.text);
  };
  const killOnAbort = () => {
    try {
      terminal.kill();
    } catch {
      // The CLI may already have exited.
    }
  };
  context.signal.addEventListener("abort", killOnAbort, { once: true });
  const exit = new Promise<number | undefined>((resolve) => {
    terminal.onExit((event) => resolve(event.exitCode));
  });
  terminal.onData((chunk) => {
    const cleanChunk = stripTerminalControl(chunk);
    output = `${output}${cleanChunk}`.slice(-100_000);
    jsonlBuffer += cleanChunk;
    let newline = jsonlBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = jsonlBuffer.slice(0, newline);
      jsonlBuffer = jsonlBuffer.slice(newline + 1);
      if (line.trim()) {
        context.onStream({ type: "antigravity-event", text: line });
        handleStructuredOutput(line);
      }
      newline = jsonlBuffer.indexOf("\n");
    }
  });
  try {
    const exitCode = await exit;
    if (jsonlBuffer.trim()) handleStructuredOutput(jsonlBuffer);
    if (context.signal.aborted) throw new Error("Antigravity run cancelled.");
    if (cliError) throw new Error(cliError);
    if (exitCode !== 0) {
      const detail = output.trim().replace(/\s+/g, " ").slice(-1_000);
      throw new Error(
        detail
          ? `Official Antigravity CLI run failed: ${detail}`
          : "Official Antigravity CLI run failed.",
      );
    }
    if (secretLooksLikeOAuthJson) {
      const refreshed = await readFile(tokenFile, "utf8").catch(() => context.secret);
      if (refreshed !== context.secret) {
        updateProviderConnection(context.connectionId, context.userId, {
          secret: refreshed,
          enabled: true,
        });
      }
    }
  } finally {
    context.signal.removeEventListener("abort", killOnAbort);
  }
  return { conversationId, usage };
}

function sdkToolPart(payload: Record<string, unknown>): ToolPart {
  const name = String(payload.name || "Antigravity tool");
  const input = typeof payload.input === "string"
    ? payload.input
    : payload.input
      ? JSON.stringify(payload.input)
      : undefined;
  const result = typeof payload.result === "string"
    ? payload.result
    : payload.error
      ? String(payload.error)
      : payload.result
        ? JSON.stringify(payload.result)
        : undefined;
  const todos = todosFromToolPayload(input, result);
  const kind = classifyTranscriptTool(name, input, result);
  return {
    id: kind === "todo" ? "todo" : String(payload.id || crypto.randomUUID()),
    name,
    status: String(payload.status || "completed"),
    kind,
    ...(input ? { input } : {}),
    ...(result ? { result } : {}),
    ...(todos?.length ? { todos } : {}),
  };
}

export async function runAntigravitySdkJob(context: {
  modelId: string;
  prompt: string;
  cwd?: string;
  conversationId?: string;
  sessionDir?: string;
  mcp?: McpServerMap;
  extraEnv?: Record<string, string>;
  apiKey?: string;
  signal: AbortSignal;
  onText: (value: string) => void;
  onStream: (data: Record<string, unknown>) => void;
  onTool?: (tool: ToolPart) => void;
}) {
  const python = process.env.ANTIGRAVITY_PYTHON?.trim() || "python3";
  const script = path.join(config.root, "scripts", "antigravity_bridge.py");
  if (!existsSync(script)) {
    throw new Error(`Antigravity SDK bridge was not found at ${script}.`);
  }
  const child = spawn(python, ["-u", script], {
    cwd: context.cwd || config.agentCwd,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      ...(context.apiKey ? { GEMINI_API_KEY: context.apiKey, GOOGLE_API_KEY: context.apiKey } : {}),
      ...(context.extraEnv || {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const payload = {
    prompt: context.prompt,
    model: context.modelId,
    cwd: context.cwd || config.agentCwd,
    api_key: context.apiKey || undefined,
    conversation_id: context.conversationId || undefined,
    session_dir: context.sessionDir || undefined,
    mcp_servers: antigravitySdkMcpServers(context.mcp || {}),
  };
  if (!child.stdin) throw new Error("Antigravity SDK bridge stdin is unavailable.");
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  let bridgeError = "";
  let conversationId = context.conversationId;
  let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type === "text" && parsed.text) {
        context.onText(String(parsed.text));
        return;
      }
      if (parsed.type === "tool") {
        context.onTool?.(sdkToolPart(parsed));
        context.onStream({ type: "sdk-tool", ...parsed });
        return;
      }
      if (parsed.type === "error") {
        bridgeError = String(parsed.message || parsed.detail || "Antigravity SDK failed.");
        context.onStream({ type: "sdk-error", message: bridgeError });
        return;
      }
      if (parsed.type === "thinking" && parsed.text) {
        context.onStream({ type: "thinking-delta", text: String(parsed.text) });
        return;
      }
      if (parsed.type === "usage") {
        usage = {
          ...(typeof parsed.input_tokens === "number" ? { inputTokens: parsed.input_tokens } : {}),
          ...(typeof parsed.output_tokens === "number" ? { outputTokens: parsed.output_tokens } : {}),
          ...(typeof parsed.total_tokens === "number" ? { totalTokens: parsed.total_tokens } : {}),
        };
        context.onStream({ type: "usage", ...parsed });
        return;
      }
      if (parsed.type === "session" && parsed.conversation_id) {
        conversationId = String(parsed.conversation_id);
        context.onStream({ type: "sdk-session", conversationId });
        return;
      }
      if (parsed.type === "done") {
        context.onStream({ type: "sdk-done" });
        return;
      }
    } catch {
      context.onStream({ type: "sdk-output", text: trimmed });
    }
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    stdout = lines.pop() || "";
    for (const line of lines) handleLine(line);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });

  const killOnAbort = () => {
    child.kill("SIGTERM");
  };
  context.signal.addEventListener("abort", killOnAbort, { once: true });
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    if (stdout.trim()) handleLine(stdout);
    if (context.signal.aborted) throw new Error("Antigravity run cancelled.");
    if (bridgeError) throw new Error(bridgeError);
    if (exitCode !== 0) {
      const detail = stderr.trim().replace(/\s+/g, " ").slice(-1_000);
      throw new Error(
        detail
          ? `Antigravity SDK run failed: ${detail}`
          : "Antigravity SDK run failed. Install google-antigravity in the Python environment.",
      );
    }
  } finally {
    context.signal.removeEventListener("abort", killOnAbort);
  }
  return { conversationId, usage };
}
