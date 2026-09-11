"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  FileDown,
 FolderKanban,
  LayoutPanelLeft,
  MessageSquare,
  PanelLeft,
  Search,
  Settings,
  Sparkles,
  StickyNote,
  SquarePen,
  Brain,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type SearchResult = {
  chatId: string;
  chatTitle: string;
  updatedAt: string;
  messageId?: string;
  role?: "user" | "assistant" | "system";
  snippet: string;
  matchedKeywords?: string[];
};

type NoteSearchResult = {
  noteId: string;
  title: string;
  content: string;
  updatedAt: string;
};

type ProjectSearchResult = {
 id: string;
 name: string;
 color: string;
 icon: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenDraft: () => void;
  onOpenChat: (chatId: string, messageId?: string) => void;
  onOpenNotes: () => void;
  onOpenNote: (noteId: string) => void;
 onOpenProject: (projectId: string) => void;
  onOpenMemories: () => void;
  onOpenSettings: () => void;
  onOpenWorkspace: () => void;
  onOpenModel: () => void;
  onToggleSidebar: () => void;
  onExport: () => void;
};

const commandItems = [
  { id: "new", label: "New chat", hint: "Ctrl/Cmd+N", icon: SquarePen },
  { id: "notes", label: "Open shared notes", icon: StickyNote },
  { id: "memories", label: "Open memories", icon: Brain },
  { id: "settings", label: "Open settings", icon: Settings },
  { id: "workspace", label: "Toggle workspace", icon: LayoutPanelLeft },
  { id: "model", label: "Choose model", icon: Sparkles },
  { id: "sidebar", label: "Toggle chat bar", icon: PanelLeft },
  { id: "export", label: "Export current chat", icon: FileDown },
] as const;

function highlightMatches(text: string, query: string): ReactNode {
  const normalized = query.trim();
  if (!normalized) return text;
  const pattern = new RegExp(`(${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  return text.split(pattern).map((part, index) =>
    String(part ?? "").toLowerCase() === String(normalized ?? "").toLowerCase() ? (
      <mark key={`${part}-${index}`} className="rounded bg-primary/20 px-0.5 text-primary">
        {part}
      </mark>
    ) : (
      <span key={`${part}-${index}`}>{part}</span>
    ),
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  onOpenDraft,
  onOpenChat,
  onOpenNotes,
  onOpenNote,
 onOpenProject,
  onOpenMemories,
  onOpenSettings,
  onOpenWorkspace,
  onOpenModel,
  onToggleSidebar,
  onExport,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [noteResults, setNoteResults] = useState<NoteSearchResult[]>([]);
 const [projectResults, setProjectResults] = useState<ProjectSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const filteredCommands = useMemo(() => {
    const normalized = String(query ?? "").trim().toLowerCase();
    if (!normalized) return commandItems;
    return commandItems.filter((item) => String(item.label ?? "").toLowerCase().includes(normalized));
  }, [query]);
  const commandCount = filteredCommands.length;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults([]);
    setNoteResults([]);
    setProjectResults([]);
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) {
      setResults([]);
      setNoteResults([]);
      setProjectResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const [chatResponse, noteResponse, projectResponse] = await Promise.all([
          fetch(`/api/chats/search?q=${encodeURIComponent(normalized)}`, {
            signal: controller.signal,
            cache: "no-store",
          }),
          fetch(`/api/notes?search=${encodeURIComponent(normalized)}`, {
            signal: controller.signal,
            cache: "no-store",
          }),
          fetch(`/api/projects?q=${encodeURIComponent(normalized)}`, {
            signal: controller.signal,
            cache: "no-store",
          }),
        ]);
        if (!chatResponse.ok) throw new Error("Search failed");
        const chatData = (await chatResponse.json()) as { results?: SearchResult[] };
        const noteData = noteResponse.ok
          ? (await noteResponse.json()) as { notes?: NoteSearchResult[] }
          : { notes: [] };
        setResults(chatData.results || []);
        setNoteResults(noteData.notes || []);
 const projectData = projectResponse.ok
 ? ((await projectResponse.json()) as { projects?: ProjectSearchResult[] })
 : { projects: [] };
 setProjectResults(projectData.projects || []);
        setActiveIndex(0);
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setResults([]);
          setNoteResults([]);
          setProjectResults([]);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 220);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  const runCommand = (id: string) => {
    onOpenChange(false);
    if (id === "new") onOpenDraft();
    if (id === "notes") onOpenNotes();
    if (id === "memories") onOpenMemories();
    if (id === "settings") onOpenSettings();
    if (id === "workspace") onOpenWorkspace();
    if (id === "model") onOpenModel();
    if (id === "sidebar") onToggleSidebar();
    if (id === "export") onExport();
  };

  const selectActive = () => {
    const command = filteredCommands[activeIndex];
    if (command) {
      runCommand(command.id);
      return;
    }
    const result = results[activeIndex - commandCount];
    if (result) {
      onOpenChange(false);
      onOpenChat(result.chatId, result.messageId);
      return;
    }
    const projectResult = projectResults[activeIndex - commandCount - results.length];
 if (projectResult) {
 onOpenChange(false);
 onOpenProject(projectResult.id);
 return;
 }
 const noteResult = noteResults[activeIndex - commandCount - results.length - projectResults.length];
    if (noteResult) {
      onOpenChange(false);
      onOpenNote(noteResult.noteId);
    }
  };

  const resultCount = results.length + noteResults.length + projectResults.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="gap-0 overflow-hidden p-0 max-sm:top-[14dvh] max-sm:translate-y-0 sm:max-w-xl"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search chats and commands</DialogTitle>
          <DialogDescription>
            Search chat messages or run an action.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b border-border/60 px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              const itemCount = query.trim()
                ? commandCount + resultCount
                : commandCount;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((current) => (current + 1) % Math.max(1, itemCount));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((current) => (current - 1 + Math.max(1, itemCount)) % Math.max(1, itemCount));
              } else if (event.key === "Enter") {
                event.preventDefault();
                selectActive();
              } else if (event.key === "Escape") {
                event.preventDefault();
                onOpenChange(false);
              }
            }}
            placeholder="Search chats or run a command…"
            aria-label="Search chats or commands"
            className="h-12 border-0 bg-popover px-0 text-sm shadow-none focus-visible:ring-0 dark:bg-popover"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="group size-7 shrink-0 max-md:min-h-11 max-md:min-w-11"
            onClick={() => onOpenChange(false)}
            aria-label="Close search"
            title="Close search"
          >
            <kbd className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground group-hover:hidden">
              ESC
            </kbd>
            <X className="hidden size-4 group-hover:block" />
          </Button>
        </div>
        <div className="max-h-[min(60vh,420px)] overflow-y-auto p-2">
          {query.trim() ? (
            <>
              {filteredCommands.length > 0 ? (
                <>
                  <p className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Commands
                  </p>
                  {filteredCommands.map((command, index) => {
                    const Icon = command.icon;
                    return (
                      <button
                        key={command.id}
                        type="button"
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left",
                          index === activeIndex ? "bg-muted" : "hover:bg-muted/60",
                        )}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => runCommand(command.id)}
                      >
                        <Icon className="size-4 text-muted-foreground" />
                        <span className="flex-1 text-sm">{command.label}</span>
                        {"hint" in command && command.hint ? <kbd className="text-[10px] text-muted-foreground">{command.hint}</kbd> : null}
                      </button>
                    );
                  })}
                </>
              ) : null}
              <p className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Chats
              </p>
              {loading ? (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">Searching…</p>
              ) : results.length > 0 ? (
                results.map((result, index) => (
                  <button
                    key={`${result.chatId}-${result.messageId || "title"}`}
                    type="button"
                    className={cn(
                      "flex w-full items-start gap-3 rounded-md px-2 py-2 text-left",
                      commandCount + index === activeIndex ? "bg-muted" : "hover:bg-muted/60",
                    )}
                    onMouseEnter={() => setActiveIndex(commandCount + index)}
                    onClick={() => {
                      onOpenChange(false);
                      onOpenChat(result.chatId, result.messageId);
                    }}
                  >
                    <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{highlightMatches(result.chatTitle, query)}</span>
                      <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
                        {highlightMatches(result.snippet, query)}
                      </span>
                      {result.matchedKeywords?.length ? (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {result.matchedKeywords.slice(0, 5).map((keyword) => (
                            <span
                              key={keyword}
                              className="rounded-full border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                            >
                              {highlightMatches(keyword, query)}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                    <ArrowRight className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ))
              ) : results.length === 0 && noteResults.length === 0 && projectResults.length === 0 ? (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">No chats found.</p>
              ) : null}
              {projectResults.length > 0 ? (
 <>
 <p className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
 Projects
 </p>
 {projectResults.map((project, index) => {
 const resultIndex = commandCount + results.length + index;
 return (
 <button
 key={project.id}
 type="button"
 className={cn(
 "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left",
 resultIndex === activeIndex ? "bg-muted" : "hover:bg-muted/60",
 )}
 onMouseEnter={() => setActiveIndex(resultIndex)}
 onClick={() => {
 onOpenChange(false);
 onOpenProject(project.id);
 }}
 >
 <FolderKanban className="size-4 shrink-0 text-muted-foreground" />
 <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: project.color }} />
 <span className="min-w-0 flex-1 truncate text-sm">{highlightMatches(project.name, query)}</span>
 <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
 </button>
 );
 })}
 </>
 ) : null}
 {noteResults.length > 0 ? (
                <>
                  <p className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Shared Notes
                  </p>
                  {noteResults.map((note, index) => {
                    const resultIndex = commandCount + results.length + projectResults.length + index;
                    return (
                      <button
                        key={note.noteId}
                        type="button"
                        className={cn(
                          "flex w-full items-start gap-3 rounded-md px-2 py-2 text-left",
                          resultIndex === activeIndex ? "bg-muted" : "hover:bg-muted/60",
                        )}
                        onMouseEnter={() => setActiveIndex(resultIndex)}
                        onClick={() => {
                          onOpenChange(false);
                          onOpenNote(note.noteId);
                        }}
                      >
                        <StickyNote className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{highlightMatches(note.title, query)}</span>
                          <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
                            {highlightMatches(note.content, query)}
                          </span>
                        </span>
                        <ArrowRight className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
                      </button>
                    );
                  })}
                </>
              ) : null}
            </>
          ) : (
            <>
              <p className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Commands
              </p>
              {filteredCommands.map((command, index) => {
                const Icon = command.icon;
                return (
                  <button
                    key={command.id}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left",
                      index === activeIndex ? "bg-muted" : "hover:bg-muted/60",
                    )}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => runCommand(command.id)}
                  >
                    <Icon className="size-4 text-muted-foreground" />
                    <span className="flex-1 text-sm">{command.label}</span>
                    {"hint" in command && command.hint ? <kbd className="text-[10px] text-muted-foreground">{command.hint}</kbd> : null}
                  </button>
                );
              })}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
