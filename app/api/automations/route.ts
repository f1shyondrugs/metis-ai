import { getAuthenticatedUserId, isAuthenticated } from "@/lib/auth";
import {
  createAutomation,
  listAutomations,
  type AutomationSchedule,
} from "@/lib/automations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function scheduleFromBody(body: Record<string, unknown>): AutomationSchedule {
  const schedule = body.schedule;
  if (!schedule || typeof schedule !== "object") throw new Error("A schedule is required.");
  const value = schedule as Record<string, unknown>;
  if (value.kind === "once") {
    if (typeof value.at !== "string") throw new Error("A one-time schedule needs an ISO timestamp.");
    return { kind: "once", at: value.at };
  }
  if (value.kind === "interval") {
    return { kind: "interval", everyMinutes: Number(value.everyMinutes) };
  }
  if (value.kind === "days") {
    return { kind: "days", everyDays: Number(value.everyDays) };
  }
  if (value.kind === "monthly") {
    return { kind: "monthly", dayOfMonth: Number(value.dayOfMonth) };
  }
  throw new Error("Unsupported schedule kind.");
}

export async function GET(req: Request) {
  if (!(await isAuthenticated(req))) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const ownerId = await getAuthenticatedUserId(req);
  if (!ownerId) return Response.json({ automations: [] });
  return Response.json({ automations: listAutomations(ownerId) });
}

export async function POST(req: Request) {
  if (!(await isAuthenticated(req))) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const ownerId = await getAuthenticatedUserId(req);
  if (!ownerId) return Response.json({ error: "Account context is required" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const automation = createAutomation({
      ownerId,
      creator: "user",
      chatId: typeof body.chatId === "string" ? body.chatId : undefined,
      name: typeof body.name === "string" ? body.name : "",
      prompt: typeof body.prompt === "string" ? body.prompt : "",
      modeId: typeof body.modeId === "string" ? body.modeId : undefined,
      modelId: typeof body.modelId === "string" ? body.modelId : undefined,
      extendedModelId: typeof body.extendedModelId === "string" ? body.extendedModelId : undefined,
      maxRunMinutes: typeof body.maxRunMinutes === "number" ? body.maxRunMinutes : undefined,
      schedule: scheduleFromBody(body),
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
          projectId: typeof body.projectId === "string" ? body.projectId : body.projectId === null ? null : undefined,
    });
    return Response.json({ automation }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not create automation." }, { status: 400 });
  }
}
