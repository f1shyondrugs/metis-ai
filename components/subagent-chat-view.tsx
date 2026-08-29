"use client";

import { ArrowLeft, Bot, CircleStop, Clock3, LoaderCircle } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import type { ToolPart } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/markdown";
import { ToolCallGroup } from "@/components/tool-call-chip";
import { ThinkingBlock } from "@/components/thinking-block";
import { stripTranscriptDump, transcriptFromToolPart } from "@/lib/agent-transcript";

type Props = {
  tool: ToolPart;
  onBack: () => void;
  onCancel?: () => void;
  cancelling?: boolean;
  sidebarWidth?: number;
};

function promptText(tool: ToolPart): string {
  const raw = tool.subagent?.prompt || tool.input || "";
  return stripTranscriptDump(typeof raw === "string" ? raw : "");
}

export function SubagentChatView({ tool, onBack, onCancel, cancelling = false, sidebarWidth = 0 }: Props) {
  const [liveTool, setLiveTool] = useState<ToolPart | null>(null);

  useEffect(() => {
    const childChatId = tool.subagent?.chatId;
    if (!childChatId) {
      setLiveTool(null);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/chats/${encodeURIComponent(childChatId)}?messageLimit=50`, { cache: "no-store" });
        if (!response.ok || cancelled) return;
        const data = await response.json() as {
          chat?: {
            runStatus?: string;
            messages?: Array<{ role?: string; content?: string; createdAt?: string; tools?: ToolPart[] }>;
          };
        };
        const chat = data.chat;
        if (!chat || cancelled) return;
        const active = ["running", "paused", "waiting_for_user", "waiting_input"].includes(chat.runStatus || "");
        const childMessages = (chat.messages || []).flatMap((message, index) => {
          const role = message.role || "assistant";
          const text = message.content || "";
          if (!text || (index === 0 && role === "user")) return [];
          return [{ role, text, ...(message.createdAt ? { timestamp: message.createdAt } : {}) }];
        });
        const childTools = (chat.messages || []).flatMap((message) => message.tools || []);
        setLiveTool({
          ...tool,
          status: active ? "running" : chat.runStatus || tool.status,
          subagent: {
            ...tool.subagent,
            ...(childMessages.length ? { messages: childMessages } : {}),
            ...(childTools.length ? { tools: childTools } : {}),
          },
        });
        if (active) timer = window.setTimeout(() => void poll(), 800);
      } catch {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 1600);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [tool.id, tool.status, tool.subagent?.chatId]);

  const displayedTool = liveTool || tool;
  const title = displayedTool.subagent?.title || displayedTool.subagent?.prompt || "Subagent chat";
  const transcript = transcriptFromToolPart(displayedTool as Parameters<typeof transcriptFromToolPart>[0]);
  const prompt = promptText(displayedTool);
  const status = displayedTool.status === "running" ? "Running" : displayedTool.status;

  const viewBlocks: Array<
    | { type: "thinking"; text: string }
    | { type: "message"; role: string; text: string }
    | { type: "tools"; tools: NonNullable<ToolPart["subagent"]>["tools"] }
  > = [];
  for (const part of transcript.parts) {
    if (part.type === "thinking") {
      viewBlocks.push({ type: "thinking", text: part.text });
      continue;
    }
    if (part.type === "message") {
      viewBlocks.push({ type: "message", role: part.role, text: stripTranscriptDump(part.text) });
      continue;
    }
    const last = viewBlocks.at(-1);
    if (last?.type === "tools") last.tools = [...(last.tools || []), part.tool];
    else viewBlocks.push({ type: "tools", tools: [part.tool] });
  }

  return (
    <section
      className="fixed inset-y-0 right-0 z-50 flex min-h-0 w-full animate-in fade-in slide-in-from-right-2 flex-col bg-background duration-200 md:w-[calc(100%-var(--subagent-sidebar-width))]"
      style={{ "--subagent-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      aria-label="Subagent chat"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/55 bg-background px-3 md:px-4">
        <Button type="button" variant="ghost" size="icon" className="size-8" onClick={onBack} aria-label="Back to chat" title="Back to chat">
          <ArrowLeft className="size-4" />
        </Button>
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={title}>{title}</p>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {displayedTool.status === "running" ? <LoaderCircle className="size-3 animate-spin" /> : <Bot className="size-3" />}
          {status}
        </span>
        {displayedTool.status === "running" && onCancel ? (
          <Button type="button" variant="destructive" size="sm" onClick={onCancel} disabled={cancelling}>
            <CircleStop className="mr-1.5 size-3.5" />
            {cancelling ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
      </header>

      <div className="messages-composer-mask min-h-0 flex-1 overflow-y-auto" style={{ ["--composer-mask-size" as string]: "9rem" }}>
        <div className="mx-auto w-full max-w-2xl space-y-6 px-4 pt-6 sm:px-6" style={{ paddingBottom: 144 }}>
          {prompt ? (
            <div className="flex flex-col items-end gap-1">
              <div className="max-w-[85%] space-y-2 rounded-xl bg-secondary/70 px-4 py-2.5 text-[15px] leading-relaxed">
                <p className="whitespace-pre-wrap break-words">{prompt}</p>
              </div>
            </div>
          ) : null}
          {viewBlocks.map((block, index) => {
            if (block.type === "thinking") {
              return (
                <ThinkingBlock
                  key={`thinking-${index}`}
                  text={block.text}
                  done={displayedTool.status !== "running" || index < viewBlocks.length - 1}
                />
              );
            }
            if (block.type === "tools") {
              return (
                <ToolCallGroup
                  key={`tools-${block.tools?.[0]?.id ?? index}`}
                  tools={block.tools || []}
                  autoExpand={false}
                />
              );
            }
            if (!block.text) return null;
            return (
              <div
                key={`message-${index}`}
                className={cn(
                  "w-full",
                  block.role === "user"
                    ? "flex flex-col items-end gap-1"
                    : "text-[15px] leading-relaxed text-foreground/95",
                )}
              >
                {block.role.toLowerCase().includes("assistant") ? (
                  <div className="block w-full">
                    <Markdown content={block.text} />
                  </div>
                ) : (
                  <div className="max-w-[85%] space-y-2 rounded-xl bg-secondary/70 px-4 py-2.5 text-[15px] leading-relaxed">
                    <p className="whitespace-pre-wrap break-words">{block.text}</p>
                  </div>
                )}
              </div>
            );
          })}
          {!viewBlocks.length ? (
            <p className="text-sm text-muted-foreground">{tool.detail || "Waiting for the subagent to respond…"}</p>
          ) : null}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
        <div className="pointer-events-none pb-4 pt-3">
          <div className="pointer-events-auto relative mx-auto w-full max-w-2xl px-4 sm:px-6">
            <div className="relative flex w-full items-center gap-2 rounded-xl border border-border/65 bg-card p-2 text-sm text-muted-foreground shadow-[0_1px_2px_rgba(0,0,0,0.16)]">
              <div className="flex min-h-10 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2">
                <Clock3 className="size-4 shrink-0" />
                <span className="truncate">This subagent chat is read-only.</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
