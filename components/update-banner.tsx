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

export function UpdateBanner() {
 const [data, setData] = useState<UpdateData | null>(null);
 const [busy, setBusy] = useState(false);
 const [prepared, setPrepared] = useState(false);
 const [externalInstallerUrl, setExternalInstallerUrl] = useState<string | null>(null);
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

 if (!data?.updateAvailable) return null;
 const release = data.release;

 async function prepareUpdate() {
 setBusy(true);
 setMessage("");
 try {
 const response = await fetch("/api/admin/system/update", { method: "POST" });
 const result = (await response.json().catch(() => ({}))) as { message?: string; error?: string; requiresActivation?: boolean; status?: string; installerUrl?: string };
 if (!response.ok) throw new Error(result.error || "Update failed.");
 setPrepared(Boolean(result.requiresActivation));
 setExternalInstallerUrl(result.status === "external-installer" ? result.installerUrl || null : null);
 setMessage(result.message || "Update prepared. Activate it to switch production slots.");
 } catch (error) {
 setMessage(error instanceof Error ? error.message : "Update failed.");
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
 body: JSON.stringify({ action: "activate", tag: data?.latestTag }),
 });
 const result = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
 if (!response.ok) throw new Error(result.error || "Activation failed.");
 setPrepared(false);
 setMessage(result.message || "Update activation started.");
 } catch (error) {
 setMessage(error instanceof Error ? error.message : "Activation failed.");
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
 {externalInstallerUrl ? (
 <a
 href={externalInstallerUrl}
 target="_blank"
 rel="noreferrer"
 className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
 >
 Download Docker installer
 </a>
 ) : null}
 {prepared ? (
 <Button type="button" size="sm" onClick={() => void activateUpdate()} disabled={busy}>
 {busy ? <LoaderCircle className="size-4 animate-spin" /> : "Activate update"}
 </Button>
 ) : (
 <Button type="button" size="sm" onClick={() => void prepareUpdate()} disabled={busy}>
 {busy ? <LoaderCircle className="size-4 animate-spin" /> : "Prepare update"}
 </Button>
 )}
 </section>
 );
}
