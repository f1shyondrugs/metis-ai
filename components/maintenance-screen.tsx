"use client";

import { RefreshCw } from "lucide-react";

export function MaintenanceScreen({ reason }: { reason?: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-12 text-foreground">
      <section className="w-full max-w-md space-y-5 text-center" role="status" aria-live="polite">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-border bg-muted/30">
          <RefreshCw className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Maintenance</p>
          <h1 className="text-xl font-semibold tracking-tight">Metis is being updated</h1>
          <p className="text-sm leading-6 text-muted-foreground">
            Metis is temporarily unavailable while the new production version is being prepared. Please keep this page open.
          </p>
          {reason ? <p className="text-xs text-muted-foreground/80">{reason}</p> : null}
        </div>
      </section>
    </main>
  );
}
