import { parseAgentTranscript } from "@/lib/agent-transcript";
import type { ToolPart } from "@/lib/store";
import { isSubagentControlName, isSubagentSpawnName } from "@/lib/subagent-bar";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return value;
  try { return JSON.parse(text); }
  catch { return value; }
}

function findDelegationMeta(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 8) return {};
  const candidate = parsed(value);
  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      const found = findDelegationMeta(item, depth + 1);
      if (Object.keys(found).length) return found;
    }
    return {};
  }
  const item = record(candidate);
  if (!Object.keys(item).length) return {};
  if (
    typeof item.agentId === "string" ||
    typeof item.jobId === "string" ||
    typeof item.chatId === "string" ||
    item.delegated === true
  ) return item;
  for (const child of Object.values(item)) {
    const found = findDelegationMeta(child, depth + 1);
    if (Object.keys(found).length) return found;
  }
  return {};
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

export function subagentMetadataFromTool(
  name: string,
  inputValue: unknown,
  resultValue: unknown,
  kind?: string,
): ToolPart["subagent"] | undefined {
  if (isSubagentControlName(name)) return undefined;
  if (kind !== "subagent" && !isSubagentSpawnName(name)) return undefined;
  const input = record(parsed(inputValue));
  const resultMeta = findDelegationMeta(resultValue);
  const transcript = parseAgentTranscript(resultValue);
  const agentId = firstString(input.agentId, resultMeta.agentId, resultMeta.jobId);
  const chatId = firstString(input.chatId, resultMeta.chatId);
  const title = firstString(input.description, input.title, resultMeta.title);
  const mode = firstString(input.mode, input.modeId, resultMeta.mode, resultMeta.modeId);
  const model = firstString(input.model, input.modelId, resultMeta.model, resultMeta.modelId);
  const messages = transcript.messages.length
    ? transcript.messages
    : Array.isArray(resultMeta.messages)
      ? resultMeta.messages.flatMap((message) => {
          const row = record(message);
          const role = firstString(row.role);
          const text = firstString(row.text, row.content);
          return role && text ? [{ role, text, ...(firstString(row.timestamp) ? { timestamp: firstString(row.timestamp) } : {}) }] : [];
        })
      : [];
  if (!agentId && !chatId && !title && !mode && !model && !transcript.thinking && !messages.length && !transcript.tools.length) {
    return undefined;
  }
  return {
    agentId,
    chatId,
    title,
    mode,
    model,
    ...(transcript.thinking ? { thinking: transcript.thinking } : {}),
    ...(messages.length ? { messages } : {}),
    ...(transcript.tools.length ? { tools: transcript.tools } : {}),
  };
}
