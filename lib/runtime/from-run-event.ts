import type { MetisRuntimeEvent, RuntimeToolStatus } from "@/lib/runtime/events";

export type DurableRunEvent = {
  id: number;
  sequence?: number;
  jobId?: string;
  chatId: string;
  event: string;
  data: unknown;
  createdAt: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function toolStatus(value: unknown): RuntimeToolStatus {
  const status = String(value || "").toLowerCase();
  if (status === "error" || status === "failed") return "failed";
  if (status === "declined" || status === "denied") return "declined";
  return "completed";
}

/**
 * Convert the durable, provider-agnostic run-event cache into the canonical
 * timeline contract. The database sequence stays the SSE replay cursor.
 */
export function runtimeEventFromRunEvent(row: DurableRunEvent): MetisRuntimeEvent | null {
  const data = record(row.data);
  const eventId = `run:${row.id}`;
  const turnId = text(row.jobId) || `turn:${row.id}`;
  const base = {
    eventId,
    chatId: row.chatId,
    createdAt: row.createdAt,
    turnId,
  } as const;

  if (row.event === "text") {
    const delta = text(data.text);
    if (!delta) return null;
    return {
      ...base,
      type: "content.delta",
      itemId: `assistant:${turnId}`,
      payload: { kind: "assistant_text", delta },
    };
  }

  if (row.event === "thinking") {
    const delta = text(data.text);
    if (!delta) return null;
    return {
      ...base,
      type: "content.delta",
      itemId: `reasoning:${turnId}`,
      payload: { kind: "reasoning_text", delta },
    };
  }

  if (row.event === "tool") {
    const callId = text(data.callId) || text(data.id) || `tool:${row.id}`;
    const name = text(data.name) || "tool";
    const status = String(data.status || "running").toLowerCase();
    if (status === "running" || status === "started" || status === "in_progress") {
      return {
        ...base,
        type: "item.tool.started",
        itemId: callId,
        payload: {
          name,
          ...(text(data.kind) ? { kind: text(data.kind) } : {}),
          ...(data.input !== undefined ? { input: data.input } : {}),
          ...(text(data.detail) ? { summary: text(data.detail) } : {}),
        },
      };
    }
    return {
      ...base,
      type: "item.tool.completed",
      itemId: callId,
      payload: {
        name,
        ...(text(data.kind) ? { kind: text(data.kind) } : {}),
        status: toolStatus(status),
        ...(data.result !== undefined ? { output: data.result } : {}),
        ...(toolStatus(status) === "failed" && text(data.result)
          ? { error: text(data.result) }
          : {}),
      },
    };
  }

  if (row.event === "question") {
    const requestId = text(data.questionId) || `request:${row.id}`;
    return {
      ...base,
      type: "request.opened",
      requestId,
      payload: {
        kind: "tool_user_input",
        title: "User input required",
        ...(data.questions !== undefined ? { args: data.questions } : {}),
      },
    };
  }

  if (row.event === "context") {
    const usedTokens = Number(data.usedTokens);
    const maxTokens = Number(data.maxTokens);
    const inputTokens = Number(data.inputTokens);
    const outputTokens = Number(data.outputTokens);
    const cachedInputTokens = Number(data.cachedInputTokens);
    const totalProcessedTokens = Number(data.totalProcessedTokens);
    const autoCompactThreshold = Number(data.autoCompactThreshold);
    const source = data.source === "estimate" ? "estimate" : "provider";
    if (!Number.isFinite(usedTokens) && !Number.isFinite(maxTokens)) return null;
    return {
      ...base,
      type: "context.pressure",
      payload: {
        usedTokens: Number.isFinite(usedTokens) ? usedTokens : 0,
        ...(Number.isFinite(maxTokens) ? { effectiveTotalTokens: maxTokens } : {}),
        ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
        ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
        ...(Number.isFinite(cachedInputTokens) ? { cachedInputTokens } : {}),
        ...(Number.isFinite(totalProcessedTokens) ? { totalProcessedTokens } : {}),
        ...(typeof data.compactsAutomatically === "boolean" ? { compactsAutomatically: data.compactsAutomatically } : {}),
        ...(Number.isFinite(autoCompactThreshold) ? { autoCompactThreshold } : {}),
        source,
      },
    };
  }

  if (row.event === "compaction") {
    const beforeTokens = Number(data.beforeTokens);
    const afterTokens = Number(data.afterTokens);
    const targetTokens = Number(data.targetTokens);
    const usedTokens = Number.isFinite(afterTokens)
      ? afterTokens
      : Number.isFinite(beforeTokens)
        ? beforeTokens
        : 0;
    return {
      ...base,
      type: "context.pressure",
      payload: {
        usedTokens,
        ...(Number.isFinite(targetTokens) ? { effectiveTotalTokens: targetTokens } : {}),
        source: "compaction",
        ...(text(data.message) ? { message: text(data.message) } : {}),
      },
    };
  }

  if (row.event === "done") {
    return {
      ...base,
      type: "turn.completed",
      payload: { stopReason: "end_turn" },
    };
  }

  if (row.event === "error") {
    return {
      ...base,
      type: "turn.failed",
      payload: { message: text(data.message) || "Agent run failed." },
    };
  }

  if (row.event === "status") {
    const status = String(data.status || "").toLowerCase();
    if (["running", "starting", "queued", "recovering"].includes(status)) {
      return {
        ...base,
        type: "turn.started",
        payload: {},
      };
    }
  }

  return null;
}
