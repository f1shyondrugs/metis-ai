import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { config } from "@/lib/config";

export type MaintenanceState = {
  active: true;
  jobId: string;
  reason: string;
  startedAt: string;
};

const statePath = path.join(config.dataDir, "metis-maintenance.json");

export async function setMaintenanceState(jobId: string, reason: string) {
  await mkdir(config.dataDir, { recursive: true });
  const state: MaintenanceState = {
    active: true,
    jobId,
    reason,
    startedAt: new Date().toISOString(),
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

export async function readMaintenanceState(): Promise<MaintenanceState | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<MaintenanceState>;
    if (parsed.active !== true || typeof parsed.jobId !== "string" || typeof parsed.reason !== "string") return null;
    return {
      active: true,
      jobId: parsed.jobId,
      reason: parsed.reason,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function clearMaintenanceState() {
  await rm(statePath, { force: true });
}
