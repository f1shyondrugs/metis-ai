const IN_FLIGHT_TOOL_STATUSES = new Set([
  "running",
  "in_progress",
  "pending",
  "started",
  "executing",
  "queued",
]);

export function isInFlightToolStatus(status: unknown) {
  return IN_FLIGHT_TOOL_STATUSES.has(String(status || "").trim().toLowerCase());
}

/**
 * Only the newest still-running tool may extend the long stall window.
 * Earlier zombie "running" rows after a later completed tool/text must not
 * keep a Codex/OpenAI turn alive forever.
 */
export function activeInFlightTool<T extends { status?: unknown }>(
  tools: readonly T[],
): T | undefined {
  const lastTerminal = tools.findLastIndex(
    (tool) => !isInFlightToolStatus(tool.status),
  );
  for (let index = tools.length - 1; index > lastTerminal; index -= 1) {
    const tool = tools[index];
    if (tool && isInFlightToolStatus(tool.status)) return tool;
  }
  return undefined;
}

export function openAIUsesResponsesApi(modelId: string) {
  return /codex/i.test(String(modelId || "").trim());
}

export function abortError(message = "Provider run aborted.") {
  return Object.assign(new Error(message), { name: "AbortError" });
}

/**
 * Codex/OpenAI streams can stay open after the last visible token.
 * AbortSignal on spawn is not enough: if the child ignores SIGTERM, the
 * async iterator never completes. Race the iterator against abort so the
 * worker can emit done/error instead of hanging the chat.
 */
export async function* iterateUntilAborted<T>(
  iterable: AsyncIterable<T>,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  let rejectAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const fail = () => rejectAbort?.(abortError());
  if (signal?.aborted) fail();
  signal?.addEventListener("abort", fail, { once: true });
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    signal?.removeEventListener("abort", fail);
    try {
      await iterator.return?.();
    } catch {
      // Producer may already be torn down by abort.
    }
  }
}
