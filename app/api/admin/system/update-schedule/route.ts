import { getAuthenticatedUserId, isAuthenticated } from "@/lib/auth";
import { isHostAdmin } from "@/lib/user-access";
import { getUpdateSchedule, nextUpdateAt, saveUpdateSchedule } from "@/lib/update-schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function admin(req: Request) {
  if (!(await isAuthenticated(req))) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isHostAdmin(await getAuthenticatedUserId(req))) return Response.json({ error: "Only host administrators can configure automatic updates." }, { status: 403 });
  return null;
}

export async function GET(req: Request) {
  const denied = await admin(req);
  if (denied) return denied;
  const schedule = getUpdateSchedule();
  return Response.json({ schedule, nextRunAt: schedule.enabled ? nextUpdateAt(schedule) : null }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PUT(req: Request) {
  const denied = await admin(req);
  if (denied) return denied;
  const body = await req.json().catch(() => ({})) as { enabled?: unknown; time?: unknown; timezone?: unknown };
  if (body.timezone && typeof body.timezone === "string") {
    try { new Intl.DateTimeFormat("en-CA", { timeZone: body.timezone }); } catch { return Response.json({ error: "Invalid timezone." }, { status: 400 }); }
  }
  const schedule = saveUpdateSchedule({
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    time: typeof body.time === "string" ? body.time : undefined,
    timezone: typeof body.timezone === "string" ? body.timezone : undefined,
  });
  return Response.json({ schedule, nextRunAt: schedule.enabled ? nextUpdateAt(schedule) : null });
}
