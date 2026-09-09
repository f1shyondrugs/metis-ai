"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Pin, X } from "lucide-react";
import type { SharedNote } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EditableMarkdown } from "@/components/editable-markdown";

type ResizeEdge = "e" | "s" | "se";

export function PinnedNotesPanel({ chatId }: { chatId: string | null }) {
  const [notes, setNotes] = useState<SharedNote[]>([]);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [chatIds, setChatIds] = useState<string[]>([]);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const positionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const sizesRef = useRef<Record<string, { width: number; height: number }>>({});
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const resizeRef = useRef<{ id: string; edge: ResizeEdge; startWidth: number; startHeight: number; pointerX: number; pointerY: number } | null>(null);
  const saveTimers = useRef(new Map<string, number>());

  async function load() {
    if (!chatId) return;
    const response = await fetch(`/api/context/pins?chatId=${encodeURIComponent(chatId)}`, { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json() as {
      notes?: SharedNote[];
      chatNoteIds?: string[];
      pinnedNoteIds?: string[];
    };
    setNotes(data.notes || []);
    setChatIds(data.chatNoteIds || []);
    setPinnedIds(data.pinnedNoteIds || []);
  }

  useEffect(() => {
    void load();
  }, [chatId]);

  useEffect(() => {
    if (!chatId) return;
    positionsRef.current = {};
    setPositions({});
    sizesRef.current = {};
    setSizes({});
    try {
      const saved = JSON.parse(localStorage.getItem(`ai-chat:pinned-note-positions:${chatId}`) || "{}");
      if (saved && typeof saved === "object") {
        positionsRef.current = saved;
        setPositions(saved);
      }
      const savedSizes = JSON.parse(localStorage.getItem(`ai-chat:pinned-note-sizes:${chatId}`) || "{}");
      if (savedSizes && typeof savedSizes === "object") {
        sizesRef.current = savedSizes;
        setSizes(savedSizes);
      }
    } catch {
      positionsRef.current = {};
      setPositions({});
      sizesRef.current = {};
      setSizes({});
    }
  }, [chatId]);

  const visible = useMemo(() => notes.filter((note) => pinnedIds.includes(note.id)), [notes, pinnedIds]);

  async function unpin(note: SharedNote) {
    const next = chatIds.filter((id) => id !== note.id);
    const response = await fetch("/api/context/pins", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, scope: "chat", noteIds: next }),
    });
    if (response.ok) {
      setChatIds(next);
      setPinnedIds((current) => current.filter((id) => id !== note.id));
      setNotes((current) => current.filter((item) => item.id !== note.id));
    }
  }

  const scheduleUpdate = useCallback((note: SharedNote, patch: Partial<SharedNote>) => {
    setNotes((current) => current.map((item) => item.id === note.id ? { ...item, ...patch } : item));
    const existing = saveTimers.current.get(note.id);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(async () => {
      const current = { ...note, ...patch };
      const response = await fetch(`/api/notes/${encodeURIComponent(note.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ ...patch, version: note.version }),
      });
      if (response.ok) {
        const data = await response.json() as { note?: SharedNote };
        if (data.note) setNotes((items) => items.map((item) => item.id === note.id ? data.note! : item));
      } else {
        setNotes((items) => items.map((item) => item.id === note.id ? current : item));
      }
      saveTimers.current.delete(note.id);
    }, 500);
    saveTimers.current.set(note.id, timer);
  }, []);

  function startDrag(event: ReactPointerEvent, note: SharedNote) {
    if (event.button !== 0) return;
    const rect = panelRef.current?.getBoundingClientRect();
    const position = positionsRef.current[note.id] || { x: 16, y: 16 };
    if (!rect) return;
    event.preventDefault();
    const nextDrag = { id: note.id, dx: event.clientX - rect.left - position.x, dy: event.clientY - rect.top - position.y };
    dragRef.current = nextDrag;
    setDrag(nextDrag);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: ReactPointerEvent) {
    const activeResize = resizeRef.current;
    if (activeResize) {
      const deltaX = event.clientX - activeResize.pointerX;
      const deltaY = event.clientY - activeResize.pointerY;
      setSizes((current) => {
        const previous = current[activeResize.id] || {
          width: activeResize.startWidth,
          height: activeResize.startHeight,
        };
        const next = {
          ...current,
          [activeResize.id]: {
            width: activeResize.edge.includes("e") ? Math.min(640, Math.max(180, activeResize.startWidth + deltaX)) : previous.width,
            height: activeResize.edge.includes("s") ? Math.min(520, Math.max(128, activeResize.startHeight + deltaY)) : previous.height,
          },
        };
        sizesRef.current = next;
        localStorage.setItem(`ai-chat:pinned-note-sizes:${chatId}`, JSON.stringify(next));
        return next;
      });
      return;
    }
    const activeDrag = dragRef.current;
    if (!activeDrag) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPositions((current) => {
      const next = {
        ...current,
        [activeDrag.id]: {
          x: Math.max(0, event.clientX - rect.left - activeDrag.dx),
          y: Math.max(0, event.clientY - rect.top - activeDrag.dy),
        },
      };
      positionsRef.current = next;
      localStorage.setItem(`ai-chat:pinned-note-positions:${chatId}`, JSON.stringify(next));
      return next;
    });
  }

  function endDrag() {
    dragRef.current = null;
    resizeRef.current = null;
    setDrag(null);
  }

  function startResize(event: ReactPointerEvent, note: SharedNote, edge: ResizeEdge) {
    event.preventDefault();
    event.stopPropagation();
    const size = sizesRef.current[note.id] || { width: note.size.width, height: note.size.height };
    resizeRef.current = {
      id: note.id,
      edge,
      startWidth: size.width,
      startHeight: size.height,
      pointerX: event.clientX,
      pointerY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  if (!chatId || !visible.length) return null;

  return (
    <div ref={panelRef} className="pointer-events-none absolute inset-0 z-10 touch-none overflow-hidden" onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      {visible.map((note, index) => {
        const position = positions[note.id] || { x: 16 + (index % 2) * 24, y: 16 + index * 20 };
        const size = sizes[note.id] || { width: note.size.width, height: note.size.height };
        return (
        <article
          key={note.id}
          className="sticky-note pointer-events-auto flex max-h-56 min-h-32 flex-col animate-in overflow-hidden rounded-md border border-black/10 shadow-lg fade-in-0 zoom-in-95 slide-in-from-top-2 duration-300"
          style={{
            position: "absolute",
            left: position.x,
            top: position.y,
            width: Math.min(640, Math.max(180, size.width)),
            height: Math.min(520, Math.max(128, size.height)),
            backgroundColor: note.color,
            ["--note-color" as string]: note.color,
            animationDelay: `${index * 70}ms`,
          }}
        >
          <div
            className={`flex shrink-0 select-none items-center gap-1 border-b border-black/10 px-2 py-1 ${drag?.id === note.id ? "cursor-grabbing" : "cursor-grab"}`}
            onPointerDown={(event) => startDrag(event, note)}
          >
            <Pin className="size-3 text-black/60" />
            <Input
              value={note.title}
              aria-label="Note title"
              onChange={(event) => scheduleUpdate(note, { title: event.target.value })}
              onPointerDown={(event) => event.stopPropagation()}
              className="h-6 min-w-0 flex-1 border-0 bg-transparent px-0 text-xs font-semibold text-black shadow-none focus-visible:ring-0"
            />
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="size-6 text-black/70 hover:bg-black/10"
              aria-label="Unpin note from this chat"
              title="Unpin from this chat"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => void unpin(note)}
            >
              <X className="size-3" />
            </Button>
          </div>
          <div
            className="editable-markdown min-h-0 flex-1 cursor-text overflow-y-auto p-2 text-xs leading-5 text-black [&_.markdown-body]:text-black [&_.markdown-body_*]:text-black [&_.markdown-body_p]:my-1 [&_.markdown-body_ul]:my-1 [&_.markdown-body_ol]:my-1"
            onPointerDown={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest(".markdown-body, input, textarea, button, a, [data-editor-control]")) return;
              startDrag(event, note);
            }}
          >
            <EditableMarkdown
              value={note.content}
              onChange={(content) => scheduleUpdate(note, { content })}
              interactiveTasks
              placeholder="Write a note…"
              aria-label="Note content"
              className="min-h-0 bg-transparent p-0 text-black [&_.markdown-body]:text-black [&_.markdown-body_*]:text-black"
            />
          </div>
          {([
            ["e", "inset-y-1/2 right-0 h-1/2 w-1 cursor-ew-resize"],
            ["s", "inset-x-1/2 bottom-0 h-1 w-1/2 -translate-x-1/2 cursor-ns-resize"],
            ["se", "bottom-0 right-0 size-3 cursor-nwse-resize"],
          ] as const).map(([edge, className]) => (
            <div
              key={edge}
              role="separator"
              aria-label={`Resize pinned note ${edge}`}
              className={`absolute z-10 touch-none select-none ${className}`}
              onPointerDown={(event) => startResize(event, note, edge)}
            />
          ))}
        </article>
        );
      })}
    </div>
  );
}
