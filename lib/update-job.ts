import { randomUUID } from "node:crypto";
import type { GithubRelease } from "@/lib/github-releases";
import { prepareNativeReleaseUpdate } from "@/lib/github-releases";
import { clearMaintenanceState, setMaintenanceState } from "@/lib/maintenance-state";

type UpdateJobResult = {
  tag: string;
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
};

const jobs = new Map<string, UpdateJob>();

export async function startNativeUpdateJob(root: string, release: GithubRelease, activeSlot: ".next-a" | ".next-b") {
  const job: UpdateJob = {
    jobId: randomUUID(),
    status: "preparing",
    startedAt: new Date().toISOString(),
  };
  await setMaintenanceState(job.jobId, "Metis is being updated. The application is temporarily unavailable while the inactive production slot is built.");
  jobs.set(job.jobId, job);

  void prepareNativeReleaseUpdate(root, release, activeSlot)
    .then(async (result) => {
      job.status = "ready";
      job.result = {
        ...result,
        preparedSlot: result.preparedSlot as ".next-a" | ".next-b",
      };
      job.finishedAt = new Date().toISOString();
      await clearMaintenanceState();
    })
    .catch(async (error) => {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = new Date().toISOString();
      await clearMaintenanceState();
    });

  return job;
}

export function getUpdateJob(jobId: string) {
  return jobs.get(jobId) || null;
}
