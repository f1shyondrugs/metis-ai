import { randomUUID } from "node:crypto";
import type { GithubRelease } from "@/lib/github-releases";
import { prepareNativeCommitUpdate, prepareNativeReleaseUpdate } from "@/lib/github-releases";
import { clearMaintenanceState, setMaintenanceState } from "@/lib/maintenance-state";

type UpdateJobResult = {
  tag: string;
  commit?: string;
  activeSlot: ".next-a" | ".next-b";
  preparedSlot: ".next-a" | ".next-b";
  asset: string;
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

async function startUpdateJob(
  prepare: (logger: (message: string) => void) => Promise<UpdateJobResult>,
) {
  const job: UpdateJob = { jobId: randomUUID(), status: "preparing", startedAt: new Date().toISOString(), logs: ["Update job created."] };
  const log = (message: string) => { job.logs.push(`${new Date().toISOString()} ${message}`); };
  log("Maintenance mode enabled.");
  await setMaintenanceState(job.jobId, "Metis is being updated. The application is temporarily unavailable while the inactive production slot is built.");
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

export function startNativeUpdateJob(root: string, release: GithubRelease, activeSlot: ".next-a" | ".next-b") {
  return startUpdateJob(async (log) => {
    const result = await prepareNativeReleaseUpdate(root, release, activeSlot, fetch, log);
    return { ...result, preparedSlot: result.preparedSlot as ".next-a" | ".next-b" };
  });
}

export function startNativeCommitUpdateJob(root: string, commit: { sha: string }, activeSlot: ".next-a" | ".next-b") {
  return startUpdateJob(async (log) => {
    const result = await prepareNativeCommitUpdate(root, commit, activeSlot, fetch, log);
    return { ...result, preparedSlot: result.preparedSlot as ".next-a" | ".next-b" };
  });
}

export function getUpdateJob(jobId: string) {
  return jobs.get(jobId) || null;
}
