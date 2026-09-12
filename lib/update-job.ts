import { randomUUID } from "node:crypto";
import { runInstallerUpdate, type InstallerUpdateInput } from "@/lib/installer-update";
import { clearMaintenanceState, setMaintenanceState } from "@/lib/maintenance-state";

type UpdateJobResult = {
  tag: string;
  commit?: string;
  method?: "installer";
  asset: string;
  activeSlot?: ".next-a" | ".next-b";
  preparedSlot?: ".next-a" | ".next-b";
};

export type UpdateJob = {
  jobId: string;
  status: "preparing" | "ready" | "failed";
  startedAt: string;
  finishedAt?: string;
  result?: UpdateJobResult;
  error?: string;
  logs: string[];
};

const jobs = new Map<string, UpdateJob>();

const INSTALLER_REASON = "Metis is being updated with the same installer used for a fresh install. Keep this page open.";

async function startUpdateJob(
  prepare: (logger: (message: string) => void) => Promise<UpdateJobResult>,
  reason = INSTALLER_REASON,
) {
  const job: UpdateJob = { jobId: randomUUID(), status: "preparing", startedAt: new Date().toISOString(), logs: ["Update job created."] };
  const log = (message: string) => { job.logs.push(`${new Date().toISOString()} ${message}`); };
  log("Maintenance mode enabled.");
  await setMaintenanceState(job.jobId, reason);
  jobs.set(job.jobId, job);
  void prepare(log).then(async (result) => {
    job.status = "ready";
    job.result = result;
    job.finishedAt = new Date().toISOString();
    log("Update prepared successfully.");
    await clearMaintenanceState();
  }).catch(async (error) => {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.finishedAt = new Date().toISOString();
    log(`Update failed: ${job.error}`);
    await clearMaintenanceState();
  });
  return job;
}

export function startInstallerUpdateJob(input: InstallerUpdateInput & { commit?: string }) {
  return startUpdateJob(async (log) => {
    const result = await runInstallerUpdate(input, log);
    return { ...result, commit: input.commit };
  });
}

export function getUpdateJob(jobId: string) {
  return jobs.get(jobId) || null;
}
