import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import type { StoredAttachment } from "@/lib/uploads";

export type JobStatus =
  | "queued"
  | "running"
  | "switching"
  | "waiting_input"
  | "waiting_for_user"
  | "completed"
  | "cancelled"
  | "interrupted"
  | "error";

export type AgentJob = {
  id: string;
  chatId: string;
  userId?: string;
  /** Higher values run first. Interactive chats default above background work. */
  priority?: number;
  workload?: "interactive" | "interactive-heavy" | "background";
  incognito?: boolean;
  message: string;
  messageId?: string;
  referenceText?: string;
  references?: Array<{
    kind: string;
    id: string;
    label: string;
    detail?: string;
    path?: string;
    content?: string;
  }>;
  agentId?: string;
  modeId?: string;
  modelId?: string;
  extendedModelId?: string;
  modelParams?: Array<{ id: string; value: string }>;
  /** Requested live model handoff for an already-running job. */
  pendingModelId?: string;
  pendingModelParams?: Array<{ id: string; value: string }>;
  modelSwitchRequestedAt?: string;
  attachments?: StoredAttachment[];
  streamDeviceId?: string;
  automationId?: string;
  automationRunId?: string;
  /** Structured provider-neutral delegation metadata for child agent runs. */
  parentJobId?: string;
  parentChatId?: string;
  subagentTitle?: string;
  subagentDedupeId?: string;
  subagentRequired?: boolean;
  subagentDepth?: number;
 /** Async child work requests a single parent review after all sibling children settle. */
 subagentAutoReview?: boolean;
 /** Internal follow-up job created by the parent-child reconciler. */
 subagentFollowUp?: boolean;
  /** Source-chat context plus recent run summaries, kept separate from the run transcript. */
  automationContext?: string;
  /** Per-run hard limit. Automations use this to support long autonomous tasks without changing normal chat limits. */
  maxRuntimeMs?: number;
  resumePrompt?: string;
  resumeRequestedAt?: string;
  runId?: string;
  queueMessage?: string;
  status: JobStatus;
  /** Monotonic optimistic-concurrency revision for durable job updates. */
  revision?: number;
  /** Process-local lease metadata, never persisted in the jobs JSON payload. */
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  error?: string;
};

const dataDir = config.dataDir;
const jobsPath = path.join(dataDir, "jobs.json");

function readJobs() {
  try {
    return existsSync(jobsPath) ? (JSON.parse(readFileSync(jobsPath, "utf8")) as AgentJob[]) : [];
  } catch {
    return [];
  }
}

function writeJobs(jobs: AgentJob[]) {
  mkdirSync(path.dirname(jobsPath), { recursive: true });
  const tmp = `${jobsPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
  renameSync(tmp, jobsPath);
}

export function enqueueJob(input: Omit<AgentJob, "id" | "status" | "attempts" | "createdAt" | "updatedAt">) {
  const now = new Date().toISOString();
  const job: AgentJob = { ...input, id: randomUUID(), status: "queued", attempts: 0, createdAt: now, updatedAt: now };
  writeJobs([...readJobs(), job]);
  return job;
}

export function getJob(id: string) {
  return readJobs().find((job) => job.id === id) ?? null;
}

export function listJobs(chatId?: string, userId?: string) {
  return readJobs().filter((job) => (!chatId || job.chatId === chatId) && (!userId || !job.userId || job.userId === userId));
}

export function claimNextJob() {
  const jobs = readJobs();
  const next = jobs.find((job) => job.status === "queued");
  if (!next) return null;
  next.status = "running";
  next.claimedAt = new Date().toISOString();
  next.updatedAt = next.claimedAt;
  next.attempts += 1;
  writeJobs(jobs);
  return next;
}

export function updateJob(id: string, patch: Partial<Pick<AgentJob, "status" | "error" | "agentId" | "claimedAt">>) {
  const jobs = readJobs();
  const job = jobs.find((item) => item.id === id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  writeJobs(jobs);
  return job;
}

export function recoverStaleJobs(maxAgeMs = 15 * 60 * 1000) {
  const jobs = readJobs();
  const cutoff = Date.now() - maxAgeMs;
  let changed = false;
  for (const job of jobs) {
    if (job.status === "running" && new Date(job.updatedAt).getTime() < cutoff) {
      job.status = "queued";
      job.error = "Recovered after worker restart.";
      job.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) writeJobs(jobs);
  return jobs.filter((job) => job.status === "queued");
}
