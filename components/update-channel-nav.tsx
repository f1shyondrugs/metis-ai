"use client";

import { useEffect, useState } from "react";
import { GitBranch, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type UpdateChannel = "releases" | "commits";
type UpdateState = {
  status?: string;
  updateAvailable?: boolean;
  latestTag?: string;
  latestCommit?: string;
  currentManifest?: { version?: string; tag?: string | null; channel?: string };
};

const STORAGE_KEY = "metis-update-channel";
const UPDATE_JOB_STORAGE_KEY = "metis-update-job";

export function UpdateChannelNav({ isHostAdmin }: { isHostAdmin: boolean }) {
  const [channel, setChannel] = useState<UpdateChannel>("releases");
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "commits" || saved === "releases") setChannel(saved);
  }, []);

  useEffect(() => {
    if (!isHostAdmin) return;
    let active = true;
    void fetch(`/api/admin/system/update?channel=${channel}`, { cache: "no-store" })
      .then(async (response) => {
        const next = (await response.json().catch(() => ({}))) as UpdateState;
        if (active) setState(next);
      })
      .catch(() => {
        if (active) setState({ status: "check-failed" });
      });
    return () => { active = false; };
  }, [channel, isHostAdmin]);

  if (!isHostAdmin) return null;
  const available = Boolean(state?.updateAvailable);
  const label = available
    ? channel === "releases"
      ? `Release ${state?.latestTag || "available"}`
      : "Commit available"
    : channel === "releases"
      ? "Releases up to date"
      : "Commits up to date";

  return (
    <div className="mt-3 border-t border-border/60 pt-3 md:mt-auto md:pt-4" data-slot="update-channel-nav">
      <div className="flex items-center gap-2 px-2 text-xs font-medium text-foreground">
        <RefreshCw className={cn("size-3.5", available && "text-primary")} />
        Updates
      </div>
      <label className="mt-2 block px-2 text-[11px] text-muted-foreground" htmlFor="settings-update-channel">
        Track
      </label>
      <select
        id="settings-update-channel"
        value={channel}
        onChange={(event) => {
          const next = event.target.value as UpdateChannel;
          setChannel(next);
          window.localStorage.setItem(STORAGE_KEY, next);
        }}
        className="mt-1 h-8 w-[calc(100%-1rem)] rounded-md border border-input bg-background px-2 text-xs"
      >
        <option value="releases">Stable releases</option>
        <option value="commits">Master commits</option>
      </select>
      <p className={cn("mt-2 flex items-center gap-1.5 px-2 text-[11px] text-muted-foreground", available && "font-medium text-primary")}>
        <GitBranch className="size-3" />
        {label}
      </p>
    </div>
  );
}

type UpdateSettingsState = {
  updateAvailable?: boolean;
  latestTag?: string;
  latestCommit?: string;
  currentManifest?: { version?: string; tag?: string | null; channel?: string };
};

type UpdateScheduleState = {
  schedule?: { enabled?: boolean; time?: string; timezone?: string };
  nextRunAt?: string | null;
};

type UpdateJobState = {
  status?: "preparing" | "ready" | "failed";
  result?: { tag?: string; preparedSlot?: string };
  error?: string;
};

export function UpdateStatusProbe({
  isHostAdmin,
  onUpdateAvailableChange,
}: {
  isHostAdmin: boolean;
  onUpdateAvailableChange: (available: boolean) => void;
}) {
  const [channel, setChannel] = useState<UpdateChannel>("releases");
  const [nextScheduledUpdate, setNextScheduledUpdate] = useState<string | null>(null);

  useEffect(() => {
    if (!isHostAdmin) return;
    let active = true;
    const loadSchedule = async () => {
      const response = await fetch("/api/admin/system/update-schedule", { cache: "no-store" });
      const next = (await response.json().catch(() => ({}))) as UpdateScheduleState;
      if (active) setNextScheduledUpdate(next.nextRunAt || null);
    };
    void loadSchedule().catch(() => undefined);
    const timer = window.setInterval(() => void loadSchedule().catch(() => undefined), 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [isHostAdmin]);

  useEffect(() => {
    if (!nextScheduledUpdate) return;
    const target = new Date(nextScheduledUpdate).getTime();
    const timers = [10, 5, 1].map((minutes) => window.setTimeout(() => toast.info(`Automatic update in ${minutes} minute${minutes === 1 ? "" : "s"}.`), Math.max(0, target - Date.now() - minutes * 60_000)));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [nextScheduledUpdate]);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "commits" || saved === "releases") setChannel(saved);
  }, []);

  useEffect(() => {
    if (!isHostAdmin) {
      onUpdateAvailableChange(false);
      return;
    }
    let active = true;
    void fetch(`/api/admin/system/update?channel=${channel}`, { cache: "no-store" })
      .then(async (response) => {
        const next = (await response.json().catch(() => ({}))) as UpdateSettingsState;
        if (active) onUpdateAvailableChange(Boolean(next.updateAvailable));
      })
      .catch(() => {
        if (active) onUpdateAvailableChange(false);
      });
    return () => { active = false; };
  }, [channel, isHostAdmin, onUpdateAvailableChange]);

  return null;
}

export function UpdateSettingsPanel({
  isHostAdmin,
  onUpdateAvailableChange,
}: {
  isHostAdmin: boolean;
  onUpdateAvailableChange: (available: boolean) => void;
}) {
  const [channel, setChannel] = useState<UpdateChannel>("releases");
  const [state, setState] = useState<UpdateSettingsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [prepared, setPrepared] = useState(false);
  const [installerUrl, setInstallerUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [schedule, setSchedule] = useState<UpdateScheduleState | null>(null);
  const [scheduleTime, setScheduleTime] = useState("03:00");
  const [scheduleTimezone, setScheduleTimezone] = useState("UTC");

  useEffect(() => {
    if (!isHostAdmin) return;
    let active = true;
    const loadSchedule = async () => {
      const response = await fetch("/api/admin/system/update-schedule", { cache: "no-store" });
      const next = (await response.json().catch(() => ({}))) as UpdateScheduleState;
      if (!active) return;
      setSchedule(next);
      setScheduleTime(next.schedule?.time || "03:00");
      setScheduleTimezone(next.schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    };
    void loadSchedule().catch(() => undefined);
    const timer = window.setInterval(() => void loadSchedule().catch(() => undefined), 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [isHostAdmin]);

  useEffect(() => {
    const savedJobId = window.localStorage.getItem(UPDATE_JOB_STORAGE_KEY);
    if (savedJobId) {
      setJobId(savedJobId);
      setPreparing(true);
    }
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "commits" || saved === "releases") setChannel(saved);
  }, []);

  useEffect(() => {
    if (!isHostAdmin) {
      onUpdateAvailableChange(false);
      return;
    }
    let active = true;
    void fetch(`/api/admin/system/update?channel=${channel}`, { cache: "no-store" })
      .then(async (response) => {
        const next = (await response.json().catch(() => ({}))) as UpdateSettingsState;
        if (!active) return;
        setState(next);
        onUpdateAvailableChange(Boolean(next.updateAvailable));
      })
      .catch(() => {
        if (active) {
          setState(null);
          onUpdateAvailableChange(false);
        }
      });
    return () => { active = false; };
  }, [channel, isHostAdmin, onUpdateAvailableChange]);

  useEffect(() => {
    if (!jobId) return;
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch(`/api/admin/system/update?job=${encodeURIComponent(jobId)}`, { cache: "no-store" });
        const job = (await response.json().catch(() => ({}))) as UpdateJobState & { error?: string };
        if (!active) return;
        if (!response.ok) {
          window.localStorage.removeItem(UPDATE_JOB_STORAGE_KEY);
          setPreparing(false);
          setJobId(null);
          setMessage(job.error || `Could not restore update preparation (HTTP ${response.status}).`);
        } else if (job.status === "ready") {
          window.localStorage.removeItem(UPDATE_JOB_STORAGE_KEY);
          setPreparing(false);
          setPrepared(false);
          setJobId(null);
          setMessage(`Update built in ${job.result?.preparedSlot || "the inactive slot"}. Activating it now…`);
          void activateUpdate();
        } else if (job.status === "failed") {
          window.localStorage.removeItem(UPDATE_JOB_STORAGE_KEY);
          setPreparing(false);
          setJobId(null);
          setMessage(job.error || "Update preparation failed without a server detail.");
        }
      } catch (error) {
        if (active) setMessage(error instanceof Error ? error.message : "Could not read update preparation status.");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [jobId]);

  async function saveSchedule(enabled: boolean) {
    try {
      const response = await fetch("/api/admin/system/update-schedule", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled, time: scheduleTime, timezone: scheduleTimezone }),
      });
      const next = (await response.json().catch(() => ({}))) as UpdateScheduleState & { error?: string };
      if (!response.ok) throw new Error(next.error || "Could not save automatic update schedule.");
      setSchedule(next);
      toast.success(enabled ? `Automatic updates scheduled for ${scheduleTime}.` : "Automatic updates disabled.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not save automatic update schedule."); }
  }

  async function prepareUpdate() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/system/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      const raw = await response.text();
      let result: {
        error?: string;
        message?: string;
        requiresActivation?: boolean;
        status?: string;
        installerUrl?: string;
        jobId?: string;
      } = {};
      try { result = JSON.parse(raw) as typeof result; } catch { /* proxy may return plain text */ }
      if (!response.ok) {
        throw new Error(result.error || raw.trim() || `Update preparation failed (HTTP ${response.status}).`);
      }
      if (result.status === "preparing" && result.jobId) {
        setPreparing(true);
        setJobId(result.jobId);
        window.localStorage.setItem(UPDATE_JOB_STORAGE_KEY, result.jobId);
        setMessage(result.message || "Update preparation started in the background.");
        return;
      }
      setPrepared(Boolean(result.requiresActivation));
      setInstallerUrl(result.status === "external-installer" ? result.installerUrl || null : null);
      setMessage(result.message || "Update prepared. Activate it to switch production slots.");
    } catch (error) {
      window.localStorage.removeItem(UPDATE_JOB_STORAGE_KEY);
      setPreparing(false);
      setMessage(error instanceof Error ? error.message : "Update preparation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function activateUpdate() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/system/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "activate", channel, tag: channel === "releases" ? state?.latestTag : undefined }),
      });
      const raw = await response.text();
      let result: { error?: string; message?: string } = {};
      try { result = JSON.parse(raw) as typeof result; } catch { /* proxy may return plain text */ }
      if (!response.ok) {
        throw new Error(result.error || raw.trim() || `Update activation failed (HTTP ${response.status}).`);
      }
      setPrepared(false);
      setMessage(result.message || "Update activation started.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Update activation failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!isHostAdmin) {
    return <p className="text-sm text-muted-foreground">Updates are available to host administrators.</p>;
  }
  const available = Boolean(state?.updateAvailable);
  const current = state?.currentManifest?.version || "development checkout";
  const target = channel === "releases" ? state?.latestTag || "latest stable release" : state?.latestCommit?.slice(0, 12) || "latest master commit";

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h3 className="text-sm font-medium">Updates</h3>
        <p className="mt-1 text-xs text-muted-foreground">Choose whether Metis follows stable releases or the latest master commits.</p>
      </div>
      <label className="block max-w-sm text-xs font-medium" htmlFor="settings-update-channel-panel">
        Update channel
        <select
          id="settings-update-channel-panel"
          value={channel}
          onChange={(event) => {
            const next = event.target.value as UpdateChannel;
            setChannel(next);
            setPrepared(false);
            setInstallerUrl(null);
            setMessage("");
            window.localStorage.setItem(STORAGE_KEY, next);
          }}
          className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="releases">Stable releases</option>
          <option value="commits">Master commits (may be buggy or broken)</option>
        </select>
      </label>
      <div className={cn(
        "flex items-start gap-3 rounded-lg border p-4",
        available ? "border-emerald-500/40 bg-emerald-500/10" : "border-border/60 bg-muted/20",
      )} role="status" aria-live="polite">
        <RefreshCw className={cn("mt-0.5 size-4 shrink-0", available ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")} />
        <div>
          <p className={cn("text-sm font-medium", available && "text-emerald-700 dark:text-emerald-300")}>
            {available ? "Update Available" : "No updates available"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Installed: {current} · Tracking: {target}
          </p>
        </div>
      </div>
      {available && (channel === "releases" || channel === "commits") ? (
        <div className="flex flex-wrap items-center gap-2">
          {channel === "releases" && installerUrl ? (
            <a
              href={installerUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center rounded-md border border-border px-3 text-xs font-medium hover:bg-muted"
            >
              Open Docker installer
            </a>
          ) : null}
          <Button type="button" size="sm" onClick={() => void prepareUpdate()} disabled={busy || preparing}>
            {busy || preparing ? <LoaderCircle className="size-4 animate-spin" /> : "Update"}
          </Button>
        </div>
      ) : null}
      {message ? <p className="text-xs text-muted-foreground" role="status">{message}</p> : null}
      <div className="space-y-3 border-t border-border/60 pt-5">
        <div>
          <h4 className="text-sm font-medium">Automatic updates</h4>
          <p className="mt-1 text-xs text-muted-foreground">Check stable releases daily and prepare them at a time you choose. Metis announces 10, 5 and 1 minute before the update.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-medium">Time<input type="time" value={scheduleTime} onChange={(event) => setScheduleTime(event.target.value)} className="mt-1 block h-9 rounded-md border border-input bg-background px-2 text-sm" /></label>
          <label className="text-xs font-medium">Timezone<input value={scheduleTimezone} onChange={(event) => setScheduleTimezone(event.target.value)} className="mt-1 block h-9 w-48 rounded-md border border-input bg-background px-2 text-sm" /></label>
          <Button type="button" size="sm" onClick={() => void saveSchedule(!(schedule?.schedule?.enabled))}>{schedule?.schedule?.enabled ? "Disable automatic updates" : "Enable automatic updates"}</Button>
        </div>
        {schedule?.nextRunAt ? <p className="text-xs text-muted-foreground">Next check: {new Date(schedule.nextRunAt).toLocaleString()}</p> : null}
      </div>
      {available && channel === "commits" ? (
        <p className="text-xs text-muted-foreground">This builds the current master commit in the inactive slot, then activates it after the build succeeds. Master commits may be buggy or broken.</p>
      ) : null}
    </div>
  );
}
