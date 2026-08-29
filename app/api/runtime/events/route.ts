import { getAuthenticatedUserId, isAuthenticated } from "@/lib/auth";
import { listRunEvents } from "@/lib/db-jobs";
import { getChat } from "@/lib/db-store";
import { captureApiError } from "@/lib/error-logs";
import { runtimeEventFromRunEvent, type DurableRunEvent } from "@/lib/runtime/from-run-event";
import { encodeRuntimeSseEvent, SSE_HEADERS } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

function cursorOf(req: Request, url: URL) {
  const value = req.headers.get("Last-Event-ID") || url.searchParams.get("after") || "0";
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function GET(req: Request) {
  if (!(await isAuthenticated(req))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const chatId = url.searchParams.get("chatId")?.trim() || "";
  if (!chatId) return Response.json({ error: "chatId is required" }, { status: 400 });
  const ownerId = await getAuthenticatedUserId(req);
  if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    if (!getChat(chatId, ownerId)) {
      return Response.json({ error: "Chat not found" }, { status: 404 });
    }

    let cursor = cursorOf(req, url);
    const encoder = new TextEncoder();
    let stopped = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (chunk: string) => {
          if (stopped) return;
          try { controller.enqueue(encoder.encode(chunk)); }
          catch { stopped = true; }
        };
        send("retry: 1500\n\n");
        let lastHeartbeat = Date.now();
        const deadline = Date.now() + 30 * 60 * 1000;
        while (!stopped && !req.signal.aborted && Date.now() < deadline) {
          const rows = listRunEvents(chatId, ownerId, cursor) as DurableRunEvent[];
          for (const row of rows) {
            cursor = Math.max(cursor, Number(row.id) || 0);
            const event = runtimeEventFromRunEvent(row);
            if (!event) continue;
            send(encodeRuntimeSseEvent({ event: "runtime", id: row.id, data: event }));
          }
          if (Date.now() - lastHeartbeat >= 15_000) {
            send(": heartbeat\n\n");
            lastHeartbeat = Date.now();
          }
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        if (!stopped) {
          stopped = true;
          try { controller.close(); } catch { /* already closed */ }
        }
      },
      cancel() { stopped = true; },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  } catch (error) {
    captureApiError("/api/runtime/events GET", error, req, { chatId });
    return Response.json({ error: "Could not open runtime event stream" }, { status: 500 });
  }
}
