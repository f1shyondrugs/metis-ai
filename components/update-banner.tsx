"use client";

import { useEffect, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

type UpdateData = {
 status?: "development" | "up-to-date" | "available" | "external-installer";
 updateAvailable?: boolean;
 latestTag?: string;
 currentManifest?: { version?: string; tag?: string | null; channel?: string };
 release?: { name?: string; body?: string; html_url?: string };
};

const UPDATE_JOB_STORAGE_KEY = "metis-update-job";

export function UpdateBanner() {
 const [data, setData] = useState<UpdateData | null>(null);
 const [busy, setBusy] = useState(false);
 const [preparing, setPreparing] = useState(false);
 const [jobId, setJobId] = useState<string | null>(null);
 const [message, setMessage] = useState("");

 useEffect(() => {
 let active = true;
 void fetch("/api/admin/system/update", { cache: "no-store" })
 .then(async (response) => {
 if (response.status === 403 || response.status === 401) return;
 const next = (await response.json().catch(() => ({}))) as UpdateData;
 if (active && response.ok) setData(next);
 })
 .catch(() => undefined);
 return () => { active = false; };
 }, []);

 useEffect(() => {
   const savedJobId = window.localStorage.getItem(UPDATE_JOB_STORAGE_KEY);
   if (savedJobId) {
     setJobId(savedJobId);
     setPreparing(true);
   }
 }, []);

 useEffect(() => {
   if (!jobId) return;
   let active = true;
   const poll = async () => {
     try {
       const response = await fetch(`/api/admin/system/update?job=${encodeURIComponent(jobId)}`, { cache: "no-store" });
       const job = (await response.json().catch(() => ({}))) as { status?: string; error?: string; result?: { tag?: string } };
       if (!active) return;
       if (!response.ok) {
         if (response.status === 404) {
           setMessage("The installer is restarting Metis. Keep this page open.");
           return;
         }
         window.localStorage.removeItem(UPDATE_JOB_STORAGE_KEY);
         setPreparing(false);
         setJobId(null);
         setMessage(job.error || `Could not restore update status (HTTP ${response.status}).`);
       } else if (job.status === "ready") {
         window.localStorage.removeItem(UPDATE_JOB_STORAGE_KEY);
         setPreparing(false);
         setJobId(null);
         setMessage(`Installer finished${job.result?.tag ? ` (${job.result.tag})` : ""}. Metis will come back after the service restart.`);
       } else if (job.status === "failed") {
         window.localStorage.removeItem(UPDATE_JOB_STORAGE_KEY);
         setPreparing(false);
         setJobId(null);
         setMessage(job.error || "Installer update failed without a server detail.");
       }
     } catch (error) {
       if (active) setMessage(error instanceof Error ? error.message : "Could not read update status.");
     }
   };
   void poll();
   const timer = window.setInterval(() => void poll(), 3_000);
   return () => {
     active = false;
     window.clearInterval(timer);
   };
 }, [jobId]);

 if (!data?.updateAvailable) return null;
 const release = data.release;

 async function prepareUpdate() {
 setBusy(true);
 setMessage("");
 try {
 const response = await fetch("/api/admin/system/update", { method: "POST" });
 const result = (await response.json().catch(() => ({}))) as { message?: string; error?: string; status?: string; jobId?: string };
 if (!response.ok) throw new Error(result.error || "Update failed.");
 if (result.status === "preparing" && result.jobId) {
   setPreparing(true);
   setJobId(result.jobId);
   window.localStorage.setItem(UPDATE_JOB_STORAGE_KEY, result.jobId);
 }
 setMessage(result.message || "Installer update started. The updating screen stays up until Metis restarts.");
 } catch (error) {
 setMessage(error instanceof Error ? error.message : "Update failed.");
 } finally {
 setBusy(false);
 }
 }

 return (
 <section className="flex items-start gap-3 border-b border-primary/20 bg-primary/5 px-4 py-3 text-sm" role="status">
 <RefreshCw className="mt-0.5 size-4 shrink-0 text-primary" />
 <div className="min-w-0 flex-1">
 <p className="font-medium">Update available{data.currentManifest?.version ? `: ${data.currentManifest.version}` : ""}{data.latestTag ? ` → ${data.latestTag}` : ""}</p>
 {release?.name ? <p className="text-muted-foreground">{release.name}</p> : null}
 {release?.body ? <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">{release.body}</p> : null}
 {message ? <p className="mt-1 text-xs text-muted-foreground">{message}</p> : null}
 </div>
 <Button type="button" size="sm" onClick={() => void prepareUpdate()} disabled={busy || preparing}>
 {busy || preparing ? <LoaderCircle className="size-4 animate-spin" /> : "Update"}
 </Button>
 </section>
 );
}
