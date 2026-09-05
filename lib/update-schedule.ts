import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDatabase } from "@/lib/sqlite";
import { config } from "@/lib/config";
import { checkForUpdate } from "@/lib/github-releases";
import { getUpdateJob, startNativeUpdateJob } from "@/lib/update-job";
import { activateProductionSlot } from "@/lib/production-slot";

const execFileAsync = promisify(execFile);

export type UpdateSchedule = {
  enabled: boolean;
  time: string;
  timezone: string;
  lastRunKey?: string;
};

const KEY = "system:update-schedule";
const DEFAULT: UpdateSchedule = { enabled: false, time: "03:00", timezone: "UTC" };

export function getUpdateSchedule(): UpdateSchedule {
  const row = getDatabase().prepare("SELECT data FROM settings WHERE key = ?").get(KEY) as { data?: string } | undefined;
  try {
    const value = JSON.parse(row?.data || "{}") as Partial<UpdateSchedule>;
    return {
      enabled: value.enabled === true,
      time: /^([01]\\d|2[0-3]):[0-5]\\d$/.test(value.time || "") ? value.time! : DEFAULT.time,
      timezone: typeof value.timezone === "string" && value.timezone ? value.timezone : DEFAULT.timezone,
      ...(value.lastRunKey ? { lastRunKey: value.lastRunKey } : {}),
    };
  } catch {
    return DEFAULT;
  }
}

export function saveUpdateSchedule(input: Partial<UpdateSchedule>) {
  const current = getUpdateSchedule();
  const next: UpdateSchedule = {
    enabled: input.enabled ?? current.enabled,
    time: input.time && /^([01]\\d|2[0-3]):[0-5]\\d$/.test(input.time) ? input.time : current.time,
    timezone: input.timezone || current.timezone,
    ...((input.lastRunKey || current.lastRunKey) ? { lastRunKey: input.lastRunKey || current.lastRunKey } : {}),
  };
  getDatabase().prepare("INSERT OR REPLACE INTO settings (key, owner_id, data) VALUES (?, NULL, ?)").run(KEY, JSON.stringify(next));
  return next;
}

function parts(date: Date, timezone: string) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function nextUpdateAt(schedule = getUpdateSchedule(), from = new Date()) {
  const [hour, minute] = schedule.time.split(":").map(Number);
  for (let offset = 0; offset < 48 * 60; offset += 1) {
    const candidate = new Date(from.getTime() + offset * 60_000);
    const p = parts(candidate, schedule.timezone);
    if (Number(p.hour) === hour && Number(p.minute) === minute) return candidate.toISOString();
  }
  return null;
}

let timer: NodeJS.Timeout | undefined;
let running = false;
export function startUpdateScheduler() {
  if (timer) return;
  const tick = async () => {
    const schedule = getUpdateSchedule();
    if (!schedule.enabled || running) return;
    const now = new Date();
    const p = parts(now, schedule.timezone);
    const [hour, minute] = schedule.time.split(":").map(Number);
    const runKey = `${p.year}-${p.month}-${p.day} ${schedule.time}`;
    if (Number(p.hour) !== hour || Number(p.minute) !== minute || schedule.lastRunKey === runKey) return;
    running = true;
    try {
      saveUpdateSchedule({ lastRunKey: runKey });
      const update = await checkForUpdate(config.root, fetch, "releases");
      if (update.updateAvailable && update.release && !config.docker) {
        const activeSlot = process.env.NEXT_DIST_DIR === ".next-a" ? ".next-a" : ".next-b";
        const job = await startNativeUpdateJob(config.root, update.release, activeSlot);
        const deadline = Date.now() + 40 * 60_000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          const current = getUpdateJob(job.jobId);
          if (current?.status === "failed") throw new Error(current.error || "Automatic update preparation failed.");
          if (current?.status === "ready") {
            await activateProductionSlot(config.root, activeSlot === ".next-a" ? ".next-b" : ".next-a");
            await execFileAsync("systemctl", ["restart", "--no-block", `${config.serviceName}.service`, `${config.serviceName}-worker.service`, `${config.serviceName}-mcp.service`], { timeout: 30_000 });
            break;
          }
        }
      }
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick().catch(() => undefined), 30_000);
  void tick().catch(() => undefined);
}
