"use client";

import Image from "next/image";
import { RefreshCw } from "lucide-react";

export function MaintenanceScreen({ reason, logs = [] }: { reason?: string; logs?: string[] }) {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-6 py-12 text-foreground">
      <Image src="/hand-left.png" alt="" width={260} height={260} className="pointer-events-none absolute left-0 top-1/2 hidden -translate-x-1/4 -translate-y-1/2 object-contain opacity-80 lg:block" priority />
      <Image src="/hand-right.png" alt="" width={260} height={260} className="pointer-events-none absolute right-0 top-1/2 hidden translate-x-1/4 -translate-y-1/2 object-contain opacity-80 lg:block" priority />
      <section className="relative z-10 w-full max-w-xl space-y-6 text-center" role="status" aria-live="polite">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-border bg-muted/30">
          <RefreshCw className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Maintenance</p>
          <h1 className="text-xl font-semibold tracking-tight">Metis is being updated</h1>
          <p className="text-sm leading-6 text-muted-foreground">Metis is temporarily unavailable while the new production version is being prepared. Please keep this page open.</p>
          {reason ? <p className="text-xs text-muted-foreground/80">{reason}</p> : null}
        </div>
        {logs.length ? (
          <div className="mx-auto max-w-lg rounded-lg border border-border/70 bg-muted/20 p-3 text-left">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Update log</p>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-muted-foreground">{logs.join("\n")}</pre>
          </div>
        ) : null}
      </section>
    </main>
  );
}
