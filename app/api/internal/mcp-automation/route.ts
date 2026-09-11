import { getAuthenticatedUserId } from "@/lib/auth";
import { internalRunLeaseAuthorized } from "@/lib/internal-run-lease";
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  runAutomationNow,
  setAutomationStatus,
  updateAutomation,
  type AutomationSchedule,
} from "@/lib/automations";
import { bearerTokenMatches } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function scheduleFromBody(body: Record<string, unknown>): AutomationSchedule | undefined {
  if (!("schedule" in body)) return undefined;
  const schedule = body.schedule;
  if (!schedule || typeof schedule !== "object") throw new Error("Invalid schedule.");
  const value = schedule as Record<string, unknown>;
  if (value.kind === "once" && typeof value.at === "string") return { kind: "once", at: value.at };
  if (value.kind === "interval") return { kind: "interval", everyMinutes: Number(value.everyMinutes) };
  if (value.kind === "days") return { kind: "days", everyDays: Number(value.everyDays) };
  if (value.kind === "monthly") return { kind: "monthly", dayOfMonth: Number(value.dayOfMonth) };
  throw new Error("Unsupported schedule.");
}

function withAutomationLink(automation: { id: string } | null) {
  if (!automation) return { automation: null };
  return { automation, automationLink: `automation://${automation.id}` };
}

export async function POST(req: Request) {
  if (!bearerTokenMatches(req, process.env.MCP_BEARER_TOKEN)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const jobId = req.headers.get("x-ai-chat-job-id")?.trim() || "";
  if (jobId && !internalRunLeaseAuthorized(req, jobId)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const ownerId = req.headers.get("x-ai-chat-user-id")?.trim() || await getAuthenticatedUserId(req);
  if (!ownerId) return Response.json({ error: "Account context is required" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const action = typeof body.action === "string" ? body.action : "list";
    if (action === "list") return Response.json({ automations: listAutomations(ownerId) });
    const id = typeof body.id === "string" ? body.id : "";
    if (action === "get") return Response.json(withAutomationLink(getAutomation(id, ownerId)));
    if (action === "create") {
      const schedule = scheduleFromBody(body);
      if (!schedule) throw new Error("A schedule is required.");
      return Response.json(withAutomationLink(createAutomation({
        ownerId,
        creator: "agent",
        chatId: typeof body.chatId === "string" ? body.chatId : req.headers.get("x-ai-chat-id") || undefined,
        name: typeof body.name === "string" ? body.name : "",
        prompt: typeof body.prompt === "string" ? body.prompt : "",
        modeId: typeof body.modeId === "string" ? body.modeId : "agent",
        modelId: typeof body.modelId === "string" ? body.modelId : undefined,
        extendedModelId: typeof body.extendedModelId === "string" ? body.extendedModelId : undefined,
        maxRunMinutes: typeof body.maxRunMinutes === "number" ? body.maxRunMinutes : undefined,
        schedule,
        timezone: typeof body.timezone === "string" ? body.timezone : undefined,
      })));
    }
    if (action === "run") return Response.json(runAutomationNow(id, ownerId));
    if (action === "pause" || action === "resume") {
      return Response.json(withAutomationLink(setAutomationStatus(id, ownerId, action === "resume" ? "active" : "paused")));
    }
    if (action === "delete") return Response.json({ ok: deleteAutomation(id, ownerId), id });
    if (action === "update") {
      const schedule = scheduleFromBody(body);
      return Response.json(withAutomationLink(updateAutomation(id, ownerId, {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
        ...(typeof body.chatId === "string" ? { chatId: body.chatId } : {}),
        ...(typeof body.modeId === "string" ? { modeId: body.modeId } : {}),
        ...(typeof body.modelId === "string" ? { modelId: body.modelId } : {}),
        ...(typeof body.extendedModelId === "string" ? { extendedModelId: body.extendedModelId } : {}),
        ...(typeof body.maxRunMinutes === "number" ? { maxRunMinutes: body.maxRunMinutes } : {}),
        ...(typeof body.timezone === "string" ? { timezone: body.timezone } : {}),
        ...(schedule ? { schedule } : {}),
      })));
    }
    return Response.json({ error: "Unsupported automation action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Automation request failed." }, { status: 400 });
  }
}
