"use client";

import { Check, Copy, ExternalLink, PanelsTopLeft, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";

export type CanvasWorkspaceCardProps = {
  title: string;
  content: string;
  workspaceLink?: string;
  onOpen?: () => void;
};

export function CanvasWorkspaceCard({ title, content, workspaceLink, onOpen }: CanvasWorkspaceCardProps) {
  const [copied, setCopied] = useState(false);
  const stats = useMemo(() => {
    const diagrams = (content.match(/```(?:mermaid|graphviz|dot)\b/gi) || []).length;
    const headings = (content.match(/^#{1,3}\s+\S/gm) || []).length;
    return { diagrams, headings };
  }, [content]);

  async function copyRawContent() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      toast.success("Canvas copied");
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Could not copy canvas");
    }
  }

  return (
    <section className="my-3 w-full overflow-hidden rounded-2xl border border-border/55 bg-card/55 shadow-sm shadow-black/5">
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-violet-400/15 bg-violet-400/[0.08] text-violet-300">
          <PanelsTopLeft className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.13em] text-violet-300/85">Canvas</span>
            {stats.diagrams ? <span className="text-[10px] text-muted-foreground/65">{stats.diagrams} diagram{stats.diagrams === 1 ? "" : "s"}</span> : null}
            {!stats.diagrams && stats.headings ? <span className="text-[10px] text-muted-foreground/65">{stats.headings} sections</span> : null}
          </div>
          <h3 className="mt-0.5 truncate text-sm font-semibold tracking-tight text-foreground" title={title}>{title}</h3>
        </div>
        {onOpen ? (
          <button type="button" className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground" aria-label="Open canvas" title="Open canvas" onClick={onOpen}>
            <ExternalLink className="size-3.5" />
          </button>
        ) : null}
      </div>

      <div className="border-y border-border/35 bg-background/35 p-3">
        <div className="relative max-h-64 overflow-hidden rounded-xl border border-border/35 bg-background/55 px-3.5 py-3 text-[13px] leading-5 text-foreground/85 shadow-inner shadow-black/[0.03] [&_.markdown-body]:m-0 [&_.markdown-body_h1]:mt-0 [&_.markdown-body_h2]:mt-2 [&_.markdown-body_p]:my-1.5">
          {content ? <Markdown content={content} /> : <p className="text-muted-foreground">No canvas content yet.</p>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2.5">
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/55"><Sparkles className="size-3" /> Live Markdown</span>
        {workspaceLink ? <span className="hidden min-w-0 flex-1 truncate px-1 text-[10px] text-muted-foreground/40 sm:block">{workspaceLink}</span> : <span className="flex-1" />}
        <button type="button" className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground" onClick={() => void copyRawContent()}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
        {onOpen ? (
          <button type="button" className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-foreground px-2.5 text-[11px] font-semibold text-background transition-opacity hover:opacity-90" onClick={onOpen}>
            <PanelsTopLeft className="size-3.5" /> Open canvas
          </button>
        ) : null}
      </div>
    </section>
  );
}
