"use client";

import { RefreshCw } from "lucide-react";
import { HandsStage } from "@/components/hands-stage";

export function MaintenanceScreen({ reason, logs = [] }: { reason?: string; logs?: string[] }) {
  return (
    <HandsStage contentClassName="space-y-6 text-center" role="status" aria-live="polite">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-border bg-muted/30">
          <RefreshCw className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Maintenance</p>
          <h1 className="text-xl font-semibold tracking-tight">Metis is being updated</h1>
          <p className="text-sm leading-6 text-muted-foreground">Metis is temporarily unavailable while the installer updates this installation. Please keep this page open.</p>
          {reason ? <p className="text-xs text-muted-foreground/80">{reason}</p> : null}
        </div>
        {logs.length ? (
          <div className="mx-auto max-w-lg rounded-lg border border-border/70 bg-muted/20 p-3 text-left">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Update log</p>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-muted-foreground">{logs.join("\n")}</pre>
          </div>
        ) : null}
    </HandsStage>
  );
}
