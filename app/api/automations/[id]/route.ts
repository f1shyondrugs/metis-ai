import { getAuthenticatedUserId, isAuthenticated } from "@/lib/auth";
import {
  deleteAutomation,
  getAutomation,
  runAutomationNow,
  setAutomationStatus,
  updateAutomation,
  type AutomationSchedule,
} from "@/lib/automations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

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

async function context(req: Request) {
  if (!(await isAuthenticated(req))) return null;
  return await getAuthenticatedUserId(req);
}

export async function GET(req: Request, { params }: Params) {
  const ownerId = await context(req);
  if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const automation = getAutomation(id, ownerId);
  return automation
    ? Response.json({ automation })
    : Response.json({ error: "Automation not found" }, { status: 404 });
}

export async function PATCH(req: Request, { params }: Params) {
  const ownerId = await context(req);
  if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const action = typeof body.action === "string" ? body.action : "";
    if (action === "run") {
      try {
        const result = runAutomationNow(id, ownerId);
        return result
          ? Response.json({
              automation: result.automation,
              jobId: result.run.jobId,
              chatId: result.run.chatId,
            }, { status: 202 })
          : Response.json({ error: "Automation not found" }, { status: 404 });
      } catch (error) {
        if (error instanceof Error && (error.name === "ActiveChatRun" || error.name === "ActiveAutomationRun")) {
          return Response.json({ error: error.message }, { status: 409 });
        }
        throw error;
      }
    }
    const automation = action === "pause" || action === "resume"
      ? setAutomationStatus(id, ownerId, action === "resume" ? "active" : "paused")
      : updateAutomation(id, ownerId, {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
          ...(typeof body.modeId === "string" ? { modeId: body.modeId } : {}),
          ...(typeof body.modelId === "string" ? { modelId: body.modelId } : {}),
          ...(typeof body.extendedModelId === "string" ? { extendedModelId: body.extendedModelId } : {}),
          ...(typeof body.maxRunMinutes === "number" ? { maxRunMinutes: body.maxRunMinutes } : {}),
          ...(typeof body.chatId === "string" ? { chatId: body.chatId } : {}),
          ...(typeof body.timezone === "string" ? { timezone: body.timezone } : {}),
        ...(body.projectId === null || typeof body.projectId === "string" ? { projectId: body.projectId as string | null } : {}),
          ...(scheduleFromBody(body) ? { schedule: scheduleFromBody(body) } : {}),
        });
    return automation
      ? Response.json({ automation })
      : Response.json({ error: "Automation not found" }, { status: 404 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not update automation." }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const ownerId = await context(req);
  if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  return deleteAutomation(id, ownerId)
    ? Response.json({ ok: true })
    : Response.json({ error: "Automation not found" }, { status: 404 });
}
