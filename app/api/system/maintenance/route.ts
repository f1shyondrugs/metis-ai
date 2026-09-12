import { config } from "@/lib/config";
import { installerUpdateIsRunning, readInstallerUpdateLog } from "@/lib/installer-update";
import { clearMaintenanceState, readMaintenanceState } from "@/lib/maintenance-state";
import { getUpdateJob } from "@/lib/update-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const state = await readMaintenanceState();
  if (!state) {
    return Response.json({ active: false }, { headers: { "Cache-Control": "no-store" } });
  }

  const job = getUpdateJob(state.jobId);
  if (job) {
    return Response.json({ ...state, logs: job.logs || [] }, { headers: { "Cache-Control": "no-store" } });
  }

  // The in-memory job dies with a service restart. Keep the overlay up while the
  // detached installer unit is still running so the updating screen stays visible.
  if (await installerUpdateIsRunning(config.serviceName)) {
    return Response.json({
      ...state,
      logs: await readInstallerUpdateLog(config.dataDir),
    }, { headers: { "Cache-Control": "no-store" } });
  }

  await clearMaintenanceState();
  return Response.json({ active: false }, { headers: { "Cache-Control": "no-store" } });
}
