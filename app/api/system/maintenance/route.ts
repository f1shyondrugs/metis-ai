import { clearMaintenanceState, readMaintenanceState } from "@/lib/maintenance-state";
import { getUpdateJob } from "@/lib/update-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const state = await readMaintenanceState();
  if (!state) {
    return Response.json({ active: false }, { headers: { "Cache-Control": "no-store" } });
  }

  // A service restart clears an in-memory update job. Do not leave users stuck
  // behind a stale maintenance screen after that recovery path.
  if (!getUpdateJob(state.jobId)) {
    await clearMaintenanceState();
    return Response.json({ active: false }, { headers: { "Cache-Control": "no-store" } });
  }

  const job = getUpdateJob(state.jobId);
  return Response.json({ ...state, logs: job?.logs || [] }, { headers: { "Cache-Control": "no-store" } });
}
