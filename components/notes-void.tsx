"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, LayoutGrid, Maximize2, Palette, Pin, PinOff, Plus, RefreshCw, Search, Trash2, X, ZoomIn, ZoomOut } from "lucide-react";
import type { SharedNote, NoteTodo } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EditableMarkdown } from "@/components/editable-markdown";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { NotePinDialog } from "@/components/note-pin-dialog";
import { NoteProjectMenu, type NoteProjectOption } from "@/components/note-project-menu";
import { pinchDistance, pinchMidpoint, viewAfterZoom } from "@/lib/notes-gestures";
import { cn } from "@/lib/utils";

type View = { x: number; y: number; zoom: number };
type ResizeEdge = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
type DragState =
  | { id: string; dx: number; dy: number; mode: "move"; armed?: boolean; originClientX?: number; originClientY?: number }
  | {
      id: string;
      mode: "resize";
      edge: ResizeEdge;
      startX: number;
      startY: number;
      startWidth: number;
      startHeight: number;
      pointerX: number;
      pointerY: number;
    }
  | null;

const NOTE_COLORS = ["#fef08a", "#bfdbfe", "#bbf7d0", "#fecdd3", "#ddd6fe", "#fed7aa"];

function requestKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

export function NotesVoid({
  chatId,
  focusNoteId,
  pinnedOnly = false,
  compact = false,
  projectId = null,
}: {
  chatId?: string | null;
  focusNoteId?: string | null;
  pinnedOnly?: boolean;
  compact?: boolean;
  projectId?: string | null;
}) {
  const [notes, setNotes] = useState<SharedNote[]>([]);
  const [globalPinnedIds, setGlobalPinnedIds] = useState<string[]>([]);
  const [configuredPinnedIds, setConfiguredPinnedIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
  const [drag, setDrag] = useState<DragState>(null);
  const [frontNoteId, setFrontNoteId] = useState<string | null>(null);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [draftTodoNoteId, setDraftTodoNoteId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SharedNote | null>(null);
  const [pinTarget, setPinTarget] = useState<SharedNote | null>(null);
  const [unpinTarget, setUnpinTarget] = useState<{ note: SharedNote; count: number } | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "saved" | "offline" | "error">("loading");
  const [error, setError] = useState("");
  const [projects, setProjects] = useState<NoteProjectOption[]>([]);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const todoInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimers = useRef(new Map<string, number>());
  const loadAbortRef = useRef<AbortController | null>(null);
  const hasInitializedViewRef = useRef(false);
 const notesRef = useRef<SharedNote[]>([]);
 const localDraftsRef = useRef(new Map<string, { title?: string; content?: string }>());
 const dirtyNoteIdsRef = useRef(new Set<string>());
 const consumedFocusNoteIdRef = useRef<string | null>(null);
  const viewRef = useRef(view);
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
 notesRef.current = notes;
  viewRef.current = view;

 const mergeLoadedNotes = useCallback((serverNotes: SharedNote[]) => {
 const currentById = new Map(notesRef.current.map((note) => [note.id, note]));
 const merged = serverNotes.map((serverNote) => {
 const local = currentById.get(serverNote.id);
 const draft = localDraftsRef.current.get(serverNote.id);
 return draft && local
 ? { ...serverNote, ...(draft.title !== undefined ? { title: draft.title } : {}), ...(draft.content !== undefined ? { content: draft.content } : {}) }
 : serverNote;
 });
 const serverIds = new Set(serverNotes.map((note) => note.id));
 for (const local of notesRef.current) {
 if (dirtyNoteIdsRef.current.has(local.id) && !serverIds.has(local.id)) merged.push(local);
 }
 notesRef.current = merged;
 setNotes(merged);
 }, []);

  const load = useCallback(async () => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setStatus("loading");
    setError("");
    try {
      const params = new URLSearchParams();
      if (chatId) params.set("chatId", chatId);
      const response = await fetch(`/api/notes?${params}`, { cache: "no-store", signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not load notes.");
      let next = Array.isArray(body.notes) ? body.notes as SharedNote[] : [];
      if (pinnedOnly && chatId) {
        const pinResponse = await fetch(`/api/context/pins?chatId=${encodeURIComponent(chatId)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const pinBody = await pinResponse.json().catch(() => ({})) as { pinnedNoteIds?: string[]; globalNoteIds?: string[] };
        const pinnedIds = new Set(pinBody.pinnedNoteIds || []);
        next = next.filter((note) => pinnedIds.has(note.id));
        setGlobalPinnedIds(pinBody.globalNoteIds || []);
        setConfiguredPinnedIds(pinBody.pinnedNoteIds || []);
      }
      mergeLoadedNotes(next);
      if (!chatId) {
        const pinResponse = await fetch("/api/context/pins", { cache: "no-store", signal: controller.signal });
        const pinBody = await pinResponse.json().catch(() => ({})) as { globalNoteIds?: string[]; configuredNoteIds?: string[] };
        setGlobalPinnedIds(pinBody.globalNoteIds || []);
        setConfiguredPinnedIds(pinBody.configuredNoteIds || []);
      }
      setStatus("saved");
      if (!hasInitializedViewRef.current && next.length) {
        const minX = Math.min(...next.map((note) => note.position.x));
        const minY = Math.min(...next.map((note) => note.position.y));
        setView({ x: -minX + 40, y: -minY + 40, zoom: 1 });
        hasInitializedViewRef.current = true;
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "Could not load notes.");
      setStatus("offline");
    }
  }, [chatId, mergeLoadedNotes, pinnedOnly]);

  useEffect(() => {
    const timers = saveTimers.current;
    void load();
    return () => {
      loadAbortRef.current?.abort();
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    const loadProjects = () => {
      void fetch("/api/projects", { cache: "no-store" })
        .then(async (response) => {
          const body = (await response.json().catch(() => ({}))) as { projects?: NoteProjectOption[] };
          if (response.ok) setProjects(body.projects || []);
        })
        .catch(() => undefined);
    };
    loadProjects();
    const refresh = () => loadProjects();
    window.addEventListener("metis:projects-changed", refresh);
    return () => window.removeEventListener("metis:projects-changed", refresh);
  }, []);

  useEffect(() => {
    if (!focusNoteId || consumedFocusNoteIdRef.current === focusNoteId) return;
    const note = notes.find((item) => item.id === focusNoteId);
    if (!note) return;
 consumedFocusNoteIdRef.current = focusNoteId;
    setFrontNoteId(note.id);
    setView((current) => {
      const bounds = surfaceRef.current?.getBoundingClientRect();
      return {
        ...current,
        x: (bounds?.width || 800) / 2 - (note.position.x + note.size.width / 2) * current.zoom,
        y: (bounds?.height || 600) / 2 - (note.position.y + note.size.height / 2) * current.zoom,
      };
    });
    const timer = window.setTimeout(() => setFrontNoteId(null), 2200);
    return () => window.clearTimeout(timer);
  }, [focusNoteId, notes]);

  useEffect(() => {
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [load]);

  useEffect(() => {
    const refreshFromAgent = () => {
      void load();
    };
    window.addEventListener("ai-chat:notes-updated", refreshFromAgent);
    return () => window.removeEventListener("ai-chat:notes-updated", refreshFromAgent);
  }, [load]);

  useEffect(() => {
    if (!draftTodoNoteId) return;
    todoInputRef.current?.focus();
    todoInputRef.current?.select();
  }, [draftTodoNoteId]);

  useEffect(() => {
    const focusSearch = () => {
      if (!compact) searchInputRef.current?.focus();
    };
    window.addEventListener("ai-chat:focus-notes-search", focusSearch);
    return () => window.removeEventListener("ai-chat:focus-notes-search", focusSearch);
  }, [compact]);

  const visibleNotes = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return notes;
    const projectNameById = new Map(
      projects.map((project) => [project.id, project.name.toLocaleLowerCase()]),
    );
    return notes.filter((note) => {
      if (note.content.toLocaleLowerCase().includes(query)) return true;
      if (note.title.toLocaleLowerCase().includes(query)) return true;
      const projectName = note.projectId ? projectNameById.get(note.projectId) : undefined;
      return Boolean(projectName?.includes(query));
    });
  }, [notes, projects, search]);

  const orderedNotes = useMemo(
    () => [...notes].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    [notes],
  );

  const mergeServerNote = useCallback((serverNote: SharedNote, local?: SharedNote) => {
 const draft = localDraftsRef.current.get(serverNote.id);
 return draft && local
 ? { ...serverNote, ...(draft.title !== undefined ? { title: draft.title } : {}), ...(draft.content !== undefined ? { content: draft.content } : {}) }
 : serverNote;
 }, []);

 const update = useCallback(async (note: SharedNote, patch: Omit<Partial<SharedNote>, "projectId"> & { projectId?: string | null }) => {
 setStatus("saving");
 try {
 const response = await fetch(`/api/notes/${encodeURIComponent(note.id)}`, {
 method: "PATCH",
 headers: {
 "Content-Type": "application/json",
 "Idempotency-Key": requestKey(),
 },
 body: JSON.stringify({ ...patch, version: note.version }),
 });
 const body = await response.json().catch(() => ({}));
 if (!response.ok) {
 if (response.status === 409 && body.note) {
 const serverNote = body.note as SharedNote;
 const current = notesRef.current.find((item) => item.id === note.id);
 const merged = mergeServerNote(serverNote, current);
 notesRef.current = notesRef.current.map((item) => item.id === note.id ? merged : item);
 setNotes(notesRef.current);
 }
 throw new Error(body.error || "Could not save note.");
 }
 const returnedNote = body.note as SharedNote;
 const draft = localDraftsRef.current.get(note.id);
 if (draft) {
 if (patch.title !== undefined && draft.title === patch.title) delete draft.title;
 if (patch.content !== undefined && draft.content === patch.content) delete draft.content;
 if (draft.title === undefined && draft.content === undefined) {
 localDraftsRef.current.delete(note.id);
 dirtyNoteIdsRef.current.delete(note.id);
 }
 }
 const current = notesRef.current.find((item) => item.id === note.id);
 const merged = mergeServerNote(returnedNote, current);
 notesRef.current = notesRef.current.map((item) => item.id === note.id ? merged : item);
 setNotes(notesRef.current);
 setStatus("saved");
 setError("");
 } catch (cause) {
 setStatus("error");
 setError(cause instanceof Error ? cause.message : "Could not save note.");
 }
 }, [mergeServerNote]);

 const scheduleUpdate = useCallback((note: SharedNote, patch: Partial<SharedNote>) => {
 const current = notesRef.current.find((item) => item.id === note.id) || note;
 if (patch.title !== undefined || patch.content !== undefined) {
 const draft = localDraftsRef.current.get(note.id) || {};
 if (patch.title !== undefined) draft.title = patch.title;
 if (patch.content !== undefined) draft.content = patch.content;
 localDraftsRef.current.set(note.id, draft);
 dirtyNoteIdsRef.current.add(note.id);
 }
 const nextNotes = notesRef.current.map((item) => item.id === note.id ? { ...item, ...patch } : item);
 notesRef.current = nextNotes;
 setNotes(nextNotes);
 const existing = saveTimers.current.get(note.id);
 if (existing) window.clearTimeout(existing);
 const timer = window.setTimeout(() => {
 const latest = notesRef.current.find((item) => item.id === note.id) || { ...current, ...patch };
 void update(latest, patch);
 saveTimers.current.delete(note.id);
 }, 500);
 saveTimers.current.set(note.id, timer);
 }, [update]);

 const commitTodos = useCallback((note: SharedNote, todos: NoteTodo[]) => {
   const current = notesRef.current.find((item) => item.id === note.id) || note;
   const nextNotes = notesRef.current.map((item) => item.id === note.id ? { ...item, todos } : item);
   notesRef.current = nextNotes;
   setNotes(nextNotes);
   void update(current, { todos });
 }, [update]);

 const setNoteProject = useCallback((note: SharedNote, nextProjectId: string | null) => {
   const current = notesRef.current.find((item) => item.id === note.id) || note;
   const next = { ...current };
   if (nextProjectId) next.projectId = nextProjectId;
   else delete next.projectId;
   notesRef.current = notesRef.current.map((item) => item.id === note.id ? next : item);
   setNotes(notesRef.current);
   void update(current, { projectId: nextProjectId });
 }, [update]);

 const create = async () => {
    setStatus("saving");
    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey() },
        body: JSON.stringify({
          scope: "global",
          kind: "note",
                   content: "",
          ...(projectId ? { projectId } : {}),
          position: { x: -view.x + 80, y: -view.y + 80 },
                   color: NOTE_COLORS[notes.length % NOTE_COLORS.length],
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not create note.");
      const created = body.note as SharedNote;
      const nextNotes = [created, ...notesRef.current.filter((item) => item.id !== created.id)];
      notesRef.current = nextNotes;
      setNotes(nextNotes);
      setStatus("saved");
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Could not create note.");
    }
  };

  const remove = async (note: SharedNote) => {
    setStatus("saving");
    try {
      const response = await fetch(`/api/notes/${encodeURIComponent(note.id)}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": requestKey(),
        },
        body: JSON.stringify({ confirm: true }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not delete note.");
      setNotes((current) => current.filter((item) => item.id !== note.id));
      setStatus("saved");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete note.");
      setStatus("error");
    }
  };

  const requestUnpin = useCallback(async (note: SharedNote) => {
    try {
      const response = await fetch(`/api/context/pins?noteId=${encodeURIComponent(note.id)}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({})) as { configuredChatIds?: string[]; globalNoteIds?: string[] };
      const count = body.globalNoteIds?.includes(note.id)
        ? Number(body.configuredChatIds?.length || 0)
        : Number(body.configuredChatIds?.length || 0);
      setUnpinTarget({ note, count });
    } catch {
      setUnpinTarget({ note, count: 0 });
    }
  }, []);

  const unpinFromChat = useCallback(async (note: SharedNote) => {
    try {
      const response = await fetch(`/api/context/pins?noteId=${encodeURIComponent(note.id)}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({})) as { configuredChatIds?: string[]; globalNoteIds?: string[] };
      const everywhere = body.globalNoteIds?.includes(note.id) ?? false;
      const chatIds = everywhere
        ? []
        : (body.configuredChatIds || []).filter((id) => id !== chatId);
      await fetch("/api/context/pins", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noteId: note.id, everywhere: false, chatIds }),
      });
      setGlobalPinnedIds((current) => current.filter((id) => id !== note.id));
      setConfiguredPinnedIds((current) => current.filter((id) => id !== note.id));
      setNotes((current) => current.filter((item) => item.id !== note.id));
    } catch {
      setError("Could not unpin note.");
      setStatus("error");
    }
  }, [chatId]);

  const isPinned = (note: SharedNote) => globalPinnedIds.includes(note.id) || configuredPinnedIds.includes(note.id);

  const changeColor = useCallback((noteId: string) => {
    const current = notes.find((item) => item.id === noteId);
    if (!current) return;
    const pending = saveTimers.current.get(noteId);
    if (pending) {
      window.clearTimeout(pending);
      saveTimers.current.delete(noteId);
    }
    const availableColors = NOTE_COLORS.filter((color) => color !== current.color);
    const color = availableColors[Math.floor(Math.random() * availableColors.length)];
    void update(current, { color });
  }, [notes, update]);

  const fitAll = useCallback((items: SharedNote[] = notes) => {
    if (!items.length) {
      setView({ x: 0, y: 0, zoom: 1 });
      return;
    }
    const minX = Math.min(...items.map((note) => note.position.x));
    const minY = Math.min(...items.map((note) => note.position.y));
    const maxX = Math.max(...items.map((note) => note.position.x + note.size.width));
    const maxY = Math.max(...items.map((note) => note.position.y + note.size.height));
    const bounds = surfaceRef.current?.getBoundingClientRect();
    const zoom = Math.max(0.25, Math.min(1.5, Math.min(
      (bounds?.width || 800) / Math.max(320, maxX - minX + 80),
      (bounds?.height || 600) / Math.max(260, maxY - minY + 80),
    )));
    setView({ x: -minX * zoom + 40, y: -minY * zoom + 40, zoom });
  }, [notes]);

  const arrangeNotes = useCallback(() => {
    if (!notes.length) return;
    const gap = 24;
    const bounds = surfaceRef.current?.getBoundingClientRect();
    const availableWidth = Math.max(320, (bounds?.width || 960) / Math.max(view.zoom, 0.25) - 80);
    const arranged: SharedNote[] = [];
    let x = 40;
    let y = 40;
    let rowHeight = 0;

    for (const note of orderedNotes) {
      if (x > 40 && x + note.size.width > availableWidth + 40) {
        x = 40;
        y += rowHeight + gap;
        rowHeight = 0;
      }
      const position = { x, y };
      scheduleUpdate(note, { position });
      arranged.push({ ...note, position });
      x += note.size.width + gap;
      rowHeight = Math.max(rowHeight, note.size.height);
    }

    setFrontNoteId(orderedNotes.at(-1)?.id ?? null);
    window.setTimeout(() => fitAll(arranged), 0);
  }, [fitAll, notes, orderedNotes, scheduleUpdate, view.zoom]);

  const localPoint = (event: React.PointerEvent) => {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    return {
      x: (event.clientX - bounds.left - view.x) / view.zoom,
      y: (event.clientY - bounds.top - view.y) / view.zoom,
    };
  };

  const startResize = (event: React.PointerEvent, note: SharedNote, edge: ResizeEdge) => {
    event.stopPropagation();
    event.preventDefault();
    const point = localPoint(event);
    setFrontNoteId(note.id);
    setDrag({
      id: note.id,
      mode: "resize",
      edge,
      startX: note.position.x,
      startY: note.position.y,
      startWidth: note.size.width,
      startHeight: note.size.height,
      pointerX: point.x,
      pointerY: point.y,
    });
    document.body.style.userSelect = "none";
    document.body.style.cursor = `${edge}-resize`;
    surfaceRef.current?.setPointerCapture(event.pointerId);
  };

  const zoomAt = useCallback((event: WheelEvent) => {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    setView((current) => {
      const anchorX = event.clientX - bounds.left;
      const anchorY = event.clientY - bounds.top;
      return viewAfterZoom(current, anchorX, anchorY, current.zoom * factor);
    });
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const wheelOptions = { capture: true, passive: false } as const;
    const handleWheel = (event: WheelEvent) => {
      const insideEditor = event.target instanceof Element && event.target.closest(".editable-markdown");
      if (insideEditor && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        zoomAt(event);
      } else {
        setView((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
      }
    };
    const bindWheel = () => {
      surface.removeEventListener("wheel", handleWheel, wheelOptions);
      surface.addEventListener("wheel", handleWheel, wheelOptions);
    };
    const resetSurfaceInteraction = () => {
      setDrag(null);
      document.body.style.removeProperty("user-select");
      document.body.style.removeProperty("cursor");
      bindWheel();
    };
    const touchOptions = { capture: true, passive: false } as const;
    const insideEditor = (target: EventTarget | null) =>
      target instanceof Element && Boolean(target.closest(".editable-markdown, input, textarea"));
    const handlePinchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        pinchRef.current = null;
        return;
      }
      if (insideEditor(event.target) && insideEditor(event.touches[0].target) && insideEditor(event.touches[1].target)) {
        pinchRef.current = null;
        return;
      }
      event.preventDefault();
      pinchRef.current = {
        distance: pinchDistance(event.touches[0], event.touches[1]),
        zoom: viewRef.current.zoom,
      };
    };
    const handlePinchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !pinchRef.current) return;
      event.preventDefault();
      const bounds = surface.getBoundingClientRect();
      const midpoint = pinchMidpoint(event.touches[0], event.touches[1]);
      const scale = pinchDistance(event.touches[0], event.touches[1]) / Math.max(1, pinchRef.current.distance);
      setView((current) =>
        viewAfterZoom(
          current,
          midpoint.clientX - bounds.left,
          midpoint.clientY - bounds.top,
          pinchRef.current!.zoom * scale,
        ),
      );
    };
    const handlePinchEnd = () => {
      pinchRef.current = null;
    };
    bindWheel();
    surface.addEventListener("touchstart", handlePinchStart, touchOptions);
    surface.addEventListener("touchmove", handlePinchMove, touchOptions);
    surface.addEventListener("touchend", handlePinchEnd);
    surface.addEventListener("touchcancel", handlePinchEnd);
    document.addEventListener("visibilitychange", resetSurfaceInteraction);
    window.addEventListener("pageshow", resetSurfaceInteraction);
    return () => {
      surface.removeEventListener("wheel", handleWheel, wheelOptions);
      surface.removeEventListener("touchstart", handlePinchStart, touchOptions);
      surface.removeEventListener("touchmove", handlePinchMove, touchOptions);
      surface.removeEventListener("touchend", handlePinchEnd);
      surface.removeEventListener("touchcancel", handlePinchEnd);
      document.removeEventListener("visibilitychange", resetSurfaceInteraction);
      window.removeEventListener("pageshow", resetSurfaceInteraction);
    };
  }, [zoomAt]);

  return (
    <div className={cn(
      "flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/40 bg-muted/10",
      compact && "pointer-events-none absolute inset-0 z-10 rounded-none border-0 bg-transparent",
    )}>
      {!compact ? <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/40 px-2 py-1.5">
        <div className="relative min-w-32 flex-1 sm:max-w-56">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input ref={searchInputRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search notes" className="h-7 pl-7 text-xs" />
        </div>
        <span className={cn("text-[10px]", status === "error" || status === "offline" ? "text-destructive" : "text-muted-foreground")}>
          {status === "loading" ? "Loading…" : status === "saving" ? "Saving…" : status === "offline" ? "Offline" : status === "error" ? "Error" : status === "saved" ? "Saved" : `${visibleNotes.length} notes`}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {!compact ? <Button type="button" size="xs" onClick={() => void create()}><Plus className="size-3.5" />New note</Button> : null}
          <Button type="button" size="xs" variant="ghost" title="Arrange notes in a tidy, consistent layout" aria-label="Arrange notes in a tidy, consistent layout" onClick={() => arrangeNotes()}><LayoutGrid className="size-3.5" />Arrange</Button>
          <Button type="button" size="icon-xs" variant="ghost" title="Fit all notes" aria-label="Fit all notes" onClick={() => fitAll()}><Maximize2 className="size-3.5" /></Button>
          <Button type="button" size="icon-xs" variant="ghost" title="Zoom out" aria-label="Zoom out" onClick={() => setView((current) => ({ ...current, zoom: Math.max(0.2, current.zoom - 0.1) }))}><ZoomOut className="size-3.5" /></Button>
          <Button type="button" size="icon-xs" variant="ghost" title="Zoom in" aria-label="Zoom in" onClick={() => setView((current) => ({ ...current, zoom: Math.min(3, current.zoom + 0.1) }))}><ZoomIn className="size-3.5" /></Button>
          <Button type="button" size="icon-xs" variant="ghost" title="Reload notes" aria-label="Reload notes" onClick={() => void load()}><RefreshCw className="size-3.5" /></Button>
        </div>
      </div> : null}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete note?"
        description="Are you sure you want to delete this note? This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleteTarget) return remove(deleteTarget);
        }}
      />
      <ConfirmDialog
        open={Boolean(unpinTarget)}
        onOpenChange={(open) => !open && setUnpinTarget(null)}
        title="Unpin shared note?"
        description={`Are you sure you want to unpin "${unpinTarget?.note.title || "Untitled note"}" for ${unpinTarget?.count || 0} chats?`}
        confirmLabel="Unpin for all"
        secondaryLabel="Configure"
        onSecondary={() => {
          if (unpinTarget) setPinTarget(unpinTarget.note);
          setUnpinTarget(null);
        }}
        onConfirm={async () => {
          if (!unpinTarget) return;
          await fetch("/api/context/pins", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ noteId: unpinTarget.note.id, everywhere: false, chatIds: [] }),
          });
          setGlobalPinnedIds((current) => current.filter((id) => id !== unpinTarget.note.id));
          setConfiguredPinnedIds((current) => current.filter((id) => id !== unpinTarget.note.id));
          setUnpinTarget(null);
        }}
      />
      <NotePinDialog
        note={pinTarget}
        open={Boolean(pinTarget)}
        onOpenChange={(open) => !open && setPinTarget(null)}
        onSaved={() => {
          setPinTarget(null);
          void load();
        }}
      />
      {error && !compact ? <div className="flex shrink-0 items-center justify-between gap-2 border-b border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive"><span className="truncate">{error}</span><Button type="button" size="xs" variant="ghost" onClick={() => void load()}>Retry</Button></div> : null}
      <div
        ref={surfaceRef}
        className={cn(
          "relative min-h-0 flex-1 touch-none overflow-hidden",
        )}
        style={{
          backgroundColor: compact ? "transparent" : "var(--background)",
          backgroundImage: compact
            ? "none"
            : "radial-gradient(circle at 1px 1px, color-mix(in oklch, var(--muted-foreground) 24%, transparent) 1px, transparent 1.2px)",
          backgroundSize: compact ? undefined : `${24 * view.zoom}px ${24 * view.zoom}px`,
          backgroundPosition: compact ? undefined : `${view.x}px ${view.y}px`,
        }}
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const point = localPoint(event);
          setDrag({ id: "__pan__", dx: point.x, dy: point.y, mode: "move" });
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag) return;
          const point = localPoint(event);
          if (drag.mode === "move" && drag.id === "__pan__") {
            setView((current) => ({ ...current, x: current.x + (point.x - drag.dx) * current.zoom, y: current.y + (point.y - drag.dy) * current.zoom }));
            return;
          }
          const note = notes.find((item) => item.id === drag.id);
          if (!note) return;
          if (drag.mode === "resize") {
            const deltaX = point.x - drag.pointerX;
            const deltaY = point.y - drag.pointerY;
            const minWidth = 160;
            const minHeight = 120;
            const nextWidth = drag.edge.includes("w")
              ? Math.max(minWidth, drag.startWidth - deltaX)
              : drag.edge.includes("e")
                ? Math.max(minWidth, drag.startWidth + deltaX)
                : drag.startWidth;
            const nextHeight = drag.edge.includes("n")
              ? Math.max(minHeight, drag.startHeight - deltaY)
              : drag.edge.includes("s")
                ? Math.max(minHeight, drag.startHeight + deltaY)
                : drag.startHeight;
            scheduleUpdate(note, {
              position: {
                x: drag.edge.includes("w")
                  ? drag.startX + (drag.startWidth - nextWidth)
                  : drag.startX,
                y: drag.edge.includes("n")
                  ? drag.startY + (drag.startHeight - nextHeight)
                  : drag.startY,
              },
              size: {
                width: nextWidth,
                height: nextHeight,
              },
            });
          } else {
            if (drag.armed) {
              const dist = Math.hypot(
                event.clientX - (drag.originClientX ?? event.clientX),
                event.clientY - (drag.originClientY ?? event.clientY),
              );
              if (dist < 8) return;
              document.body.style.userSelect = "none";
              document.body.style.cursor = "move";
              setDrag({ ...drag, armed: false });
              if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
              event.currentTarget.setPointerCapture(event.pointerId);
            }
            scheduleUpdate(note, { position: { x: point.x - drag.dx, y: point.y - drag.dy } });
          }
        }}
        onPointerUp={(event) => {
          if (drag?.mode === "move" && drag.armed) {
            const editor = (event.target instanceof Element ? event.target.closest("[data-note-card]") : null)
              ?.querySelector<HTMLElement>(".editable-markdown");
            editor?.focus();
          }
          setDrag(null);
          document.body.style.removeProperty("user-select");
          document.body.style.removeProperty("cursor");
          const captureTarget = event.target instanceof Element ? event.target : event.currentTarget;
 if (captureTarget.hasPointerCapture(event.pointerId)) captureTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          setDrag(null);
          document.body.style.removeProperty("user-select");
          document.body.style.removeProperty("cursor");
        }}
      >
        {[...visibleNotes].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map((note, index) => (
          <article
            key={note.id}
            data-note-card
            className={cn(
              "sticky-note pointer-events-auto absolute flex cursor-move flex-col overflow-hidden rounded-md border border-black/10 shadow-md transition-shadow",
              note.id === frontNoteId && "ring-4 ring-primary ring-offset-2 ring-offset-background",
            )}
            style={{
              left: note.position.x * view.zoom + view.x,
              top: note.position.y * view.zoom + view.y,
              width: note.size.width,
              height: note.size.height,
              transform: `scale(${view.zoom})`,
              transformOrigin: "top left",
              backgroundColor: note.color,
              ["--note-color" as string]: note.color,
              zIndex: note.id === frontNoteId ? visibleNotes.length + 1 : index + 1,
              touchAction: "none",
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              setFrontNoteId(note.id);
              const target = event.target as HTMLElement;
              const fromContent = Boolean(target.closest(".markdown-body, input, textarea, button, a, [data-editor-control]"));
              const fromEditorEmpty = Boolean(target.closest(".editable-markdown")) && !fromContent;
              const point = localPoint(event);
              if (fromEditorEmpty) {
                setDrag({
                  id: note.id,
                  dx: point.x - note.position.x,
                  dy: point.y - note.position.y,
                  mode: "move",
                  armed: true,
                  originClientX: event.clientX,
                  originClientY: event.clientY,
                });
                return;
              }
              event.preventDefault();
              setDrag({ id: note.id, dx: point.x - note.position.x, dy: point.y - note.position.y, mode: "move" });
              document.body.style.userSelect = "none";
              document.body.style.cursor = "move";
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
          >
            <div className="flex select-none items-center gap-1 border-b border-black/10 px-2 py-1">
              {editingTitleId === note.id ? (
                <Input
                  autoFocus
                  value={note.title}
                  onChange={(event) => scheduleUpdate(note, { title: event.target.value })}
                  onBlur={() => setEditingTitleId(null)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === "Escape") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                  className="h-6 min-w-0 flex-1 border-0 bg-transparent px-0 text-xs font-semibold text-black shadow-none focus-visible:ring-0"
                  aria-label="Note title"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    setFrontNoteId(note.id);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate bg-transparent px-0 text-left text-xs font-semibold text-black outline-none"
                  onClick={(event) => {
                    event.stopPropagation();
                    setEditingTitleId(note.id);
                  }}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    setFrontNoteId(note.id);
                  }}
                  aria-label={`Edit note title: ${note.title}`}
                >
                  {note.title || (note.kind === "project" ? "Untitled project" : "Untitled note")}
                </button>
              )}
              <NoteProjectMenu
                projectId={note.projectId}
                projects={projects}
                onChange={(nextProjectId) => setNoteProject(note, nextProjectId)}
              />
              <div className="relative shrink-0">
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="size-6 text-black/70 hover:bg-black/10"
                  aria-label="Add todo"
                  title="Add todo"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    setFrontNoteId(note.id);
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    setFrontNoteId(note.id);
                    setDraftTodoNoteId((current) => current === note.id ? null : note.id);
                  }}
                >
                  <Plus className="size-3" />
                </Button>
                {draftTodoNoteId === note.id ? (
                  <div
                    className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border border-border bg-popover p-1 shadow-md"
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <input
                      ref={todoInputRef}
                      autoFocus
                      className="h-6 w-full bg-transparent px-1 text-[11px] text-popover-foreground outline-none placeholder:text-muted-foreground"
                      placeholder="Add a todo"
                      aria-label="New todo"
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setDraftTodoNoteId(null);
                          event.currentTarget.blur();
                          return;
                        }
                        if (event.key !== "Enter") return;
                        const content = event.currentTarget.value.trim();
                        event.preventDefault();
                        if (content) {
                          commitTodos(note, [
                            ...(note.todos || []),
                            { id: `todo-${Date.now()}`, content, status: "pending" },
                          ]);
                          event.currentTarget.value = "";
                        } else {
                          setDraftTodoNoteId(null);
                          event.currentTarget.blur();
                        }
                      }}
                      onBlur={(event) => {
                        const content = event.currentTarget.value.trim();
                        if (content) {
                          commitTodos(note, [
                            ...(note.todos || []),
                            { id: `todo-${Date.now()}`, content, status: "pending" },
                          ]);
                        }
                        setDraftTodoNoteId((current) => current === note.id ? null : current);
                      }}
                    />
                  </div>
                ) : null}
              </div>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="size-6 text-black/70 hover:bg-black/10"
                aria-label="Change note color"
                title="Change note color"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  setFrontNoteId(note.id);
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  changeColor(note.id);
                }}
              >
                <Palette className="size-3" />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="size-6 text-black/70 hover:bg-black/10"
                aria-label={isPinned(note) ? "Unpin note from every chat" : "Pin note in every chat"}
                title={isPinned(note) ? "Unpin from every chat" : "Pin in every chat"}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  setFrontNoteId(note.id);
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (isPinned(note)) void (compact ? unpinFromChat(note) : requestUnpin(note));
                  else setPinTarget(note);
                }}
              >
                {isPinned(note) ? <PinOff className="size-3" /> : <Pin className="size-3" />}
              </Button>
              {compact ? (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="size-6 text-black/70 hover:bg-black/10"
                  aria-label="Open note in Shared Notes"
                  title="Open in Shared Notes"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    setFrontNoteId(note.id);
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    window.dispatchEvent(new CustomEvent("ai-chat:open-note", { detail: { id: note.id, chatId } }));
                  }}
                >
                  <ExternalLink className="size-3" />
                </Button>
              ) : null}
              {!compact ? <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="size-6 text-black/70 hover:bg-black/10"
                aria-label="Delete note"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  setFrontNoteId(note.id);
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  setDeleteTarget(note);
                }}
              >
                <Trash2 className="size-3" />
              </Button> : null}
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
            <div
              className="shrink-0 space-y-1 px-2 pt-1.5"
              onPointerDown={(event) => event.stopPropagation()}
            >
              {(note.todos || []).map((todo, index) => {
                const done = todo.status === "completed";
                return (
                  <div
                    key={todo.id || `${todo.content}-${index}`}
                    className="group relative flex min-w-0 items-center gap-1.5 pr-4 text-[11px] text-black/80"
                  >
                    <label className="flex min-w-0 flex-1 items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={done}
                        onChange={() => {
                          const next = (note.todos || []).map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, status: (done ? "pending" : "completed") as NoteTodo["status"] }
                              : item,
                          );
                          commitTodos(note, next);
                        }}
                      />
                      <span className={done ? "truncate line-through opacity-60" : "truncate"}>{todo.content}</span>
                    </label>
                    <button
                      type="button"
                      aria-label={`Delete todo: ${todo.content}`}
                      title="Delete todo"
                      className="absolute right-0 top-1/2 -translate-y-1/2 rounded p-0.5 text-black/35 opacity-0 transition-opacity duration-150 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 hover:text-black/60 focus-visible:pointer-events-auto focus-visible:opacity-100"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const next = (note.todos || []).filter((_, itemIndex) => itemIndex !== index);
                        commitTodos(note, next);
                      }}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
            <EditableMarkdown
              value={note.content}
              onChange={(value) => scheduleUpdate(note, { content: value })}
              interactiveTasks
              className="min-h-0 flex-1 cursor-text bg-transparent text-xs text-black [&_.markdown-body]:text-black [&_.markdown-body_p]:my-1 [&_.markdown-body_ul]:my-1 [&_.markdown-body_ol]:my-1"
              placeholder={note.kind === "project" ? "Project notes…" : "Write a note…"}
              aria-label="Note content"
              onPointerDown={(event) => {
                setFrontNoteId(note.id);
                const target = event.target as HTMLElement;
                if (target.closest(".markdown-body, input, textarea, button, a, [data-editor-control]")) {
                  event.stopPropagation();
                }
              }}
            />
            </div>
            {([
              ["n", "inset-x-1/2 top-0 h-2 w-1/2 -translate-x-1/2 cursor-ns-resize"],
              ["ne", "right-0 top-0 size-3 cursor-nesw-resize"],
              ["e", "inset-y-1/2 right-0 h-1/2 w-2 -translate-y-1/2 cursor-ew-resize"],
              ["se", "bottom-0 right-0 size-3 cursor-nwse-resize"],
              ["s", "inset-x-1/2 bottom-0 h-2 w-1/2 -translate-x-1/2 cursor-ns-resize"],
              ["sw", "bottom-0 left-0 size-3 cursor-nesw-resize"],
              ["w", "inset-y-1/2 left-0 h-1/2 w-2 -translate-y-1/2 cursor-ew-resize"],
              ["nw", "left-0 top-0 size-3 cursor-nwse-resize"],
            ] as const).map(([edge, className]) => (
              <div
                key={edge}
                role="separator"
                aria-label={`Resize note ${edge}`}
                title="Resize note"
                className={cn("absolute z-10 touch-none select-none", className)}
                onPointerDown={(event) => startResize(event, note, edge)}
              />
            ))}
          </article>
        ))}
        {!compact && status === "loading" ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 p-8 text-center text-xs text-muted-foreground" aria-live="polite">
            <RefreshCw className="size-4 animate-spin" aria-hidden="true" />
            Loading notes…
          </div>
        ) : !compact && !visibleNotes.length ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8 text-center text-xs text-muted-foreground">
            No notes yet. Create one to share context with the agent.
          </div>
        ) : null}
      </div>
    </div>
  );
}
