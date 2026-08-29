export type SseEvent =
  | { event: "text"; data: { text: string } }
  | { event: "text-reset"; data: Record<string, never> }
  | {
      event: "thinking";
      data: {
        text?: string;
        replace?: boolean;
        done?: boolean;
        durationMs?: number;
      };
    }
  | {
      event: "tool";
      data: {
        callId: string;
        name: string;
        status: string;
        detail?: string;
        kind?: "plan" | "edit" | "read" | "shell" | "subagent" | "mcp" | "canvas" | "note" | "todo" | "browser" | "memory" | "automation" | "compaction" | "other";
        path?: string;
        input?: string;
        result?: string;
        todos?: Array<{ id?: string; content: string; status?: string }>;
        subagent?: {
          agentId?: string;
          chatId?: string;
          mode?: string;
          model?: string;
          prompt?: string;
          messages?: Array<{ role: string; text: string; timestamp?: string }>;
        };
        diff?: {
          before?: string;
          after?: string;
          additions?: number;
          deletions?: number;
        };
      };
    }
  | { event: "status"; data: { status: string; message?: string } }
  | {
      event: "compaction";
      data: {
        type: "compaction";
        id: string;
 name: "context_compaction";
 kind: "compaction";
 systemTriggered: true;
 status: "started" | "completed" | "error";
        beforeTokens?: number;
        targetTokens?: number;
        afterTokens?: number;
        removedMessages?: number;
        message?: string;
      };
    }
  | { event: "agentId"; data: { agentId: string } }
  | { event: "assistantId"; data: { messageId: string } }
  | {
      event: "suggestions";
      data: { suggestions: Array<string | { label: string; prompt: string }> };
    }
  | { event: "canvas"; data: { canvas: string } }
  | { event: "workspace"; data: { workspace: import("@/lib/store").WorkspaceItem } }
  | {
      event: "question";
      data: {
        questionId: string;
        questions: Array<{
          id: string;
          question: string;
          options?: Array<{ label: string; value?: string }>;
        }>;
      };
    }
  | {
      event: "done";
      data: { agentId: string; status: string; title?: string };
    }
  | { event: "error"; data: { message: string } };

export function encodeSse(evt: SseEvent): string {
  return `event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`;
}

export function createSseStream(
  handler: (
    send: (evt: SseEvent) => void,
    close: () => void,
  ) => Promise<void>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;

  return new ReadableStream({
    async start(controller) {
      const send = (evt: SseEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(encodeSse(evt)));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      try {
        await handler(send, close);
      } catch (err) {
        send({
          event: "error",
          data: {
            message: err instanceof Error ? err.message : "Unexpected error",
          },
        });
        close();
      }
    },
    cancel() {
      closed = true;
    },
  });
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

export interface RuntimeSseEvent {
  event: "runtime";
  id?: number;
  data: unknown;
}

export function encodeRuntimeSseEvent(evt: RuntimeSseEvent): string {
  return `${evt.id === undefined ? "" : `id: ${evt.id}\n`}event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`;
}
