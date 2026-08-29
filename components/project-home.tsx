"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ImagePlus, Plus, StickyNote, Trash2, Upload, X } from "lucide-react";
import { ProjectAvatar, ProjectIconGlyph } from "@/components/project-avatar";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MAX_PROJECT_FILE_BYTES, PROJECT_COLORS, PROJECT_ICONS } from "@/lib/project-constants";
import { cn } from "@/lib/utils";

type ProjectHomeData = {
 project: {
  id: string;
  name: string;
  icon: string;
  color: string;
  instructions: string;
  memoryMode: "default" | "project_only";
  logoStoredName?: string;
  updatedAt?: string;
 };
 files: Array<{ id: string; name: string; mimeType: string; size: number }>;
 notes: Array<{ id: string; title: string }>;
 chats: Array<{ id: string; title: string }>;
};

function formatBytes(size: number) {
 if (size < 1024) return `${size} B`;
 if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
 return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function ProjectHomeSkeleton() {
 return (
 <div
 className="mx-auto flex h-full min-h-0 w-full max-w-2xl flex-col gap-6 overflow-hidden px-4 py-5 sm:gap-8 sm:px-6 sm:py-8"
 aria-busy="true"
 aria-label="Loading project"
 data-slot="project-home-skeleton"
 >
 <header className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-4 sm:grid-cols-[3.5rem_minmax(0,1fr)_auto] sm:gap-4">
 <div className="size-14 shrink-0 animate-pulse rounded-xl bg-muted" />
 <div className="min-w-0 space-y-2">
 <div className="h-8 w-2/3 animate-pulse rounded-md bg-muted" />
 <p className="text-sm text-muted-foreground">Loading project…</p>
 <div className="h-3 w-40 animate-pulse rounded bg-muted" />
 </div>
 <div className="col-span-2 grid grid-cols-2 gap-2 sm:col-span-1 sm:flex sm:shrink-0">
 <div className="h-9 min-w-0 animate-pulse rounded-md bg-muted sm:w-24" />
 <div className="h-9 min-w-0 animate-pulse rounded-md bg-muted sm:w-20" />
 </div>
 </header>
 <div className="h-28 animate-pulse rounded-xl border border-border/40 bg-muted/40" />
 <div className="grid gap-4 sm:grid-cols-2">
 <div className="h-36 animate-pulse rounded-xl border border-border/40 bg-muted/40" />
 <div className="h-36 animate-pulse rounded-xl border border-border/40 bg-muted/40" />
 </div>
 <div className="h-40 animate-pulse rounded-xl border border-border/40 bg-muted/40" />
 </div>
 );
}

async function fileToBase64(file: File) {
 const buf = await file.arrayBuffer();
 const bytes = new Uint8Array(buf);
 let binary = "";
 for (let i = 0; i < bytes.length; i += 0x8000) {
  binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
 }
 return btoa(binary);
}

export function ProjectHome({
 projectId,
 onOpenChat,
 onNewChat,
 onOpenNotes,
 onDeleted,
}: {
 projectId: string;
 onOpenChat: (chatId: string) => void;
 onNewChat: (projectId: string) => void;
 onOpenNotes: (noteId?: string) => void;
 onDeleted: () => void;
}) {
 const [data, setData] = useState<ProjectHomeData | null>(null);
 const [name, setName] = useState("");
 const [instructions, setInstructions] = useState("");
 const [memoryMode, setMemoryMode] = useState<"default" | "project_only">("default");
 const [color, setColor] = useState(PROJECT_COLORS[0]);
 const [icon, setIcon] = useState<string>(PROJECT_ICONS[0]);
 const [error, setError] = useState("");
 const [busy, setBusy] = useState(false);
 const [deleteOpen, setDeleteOpen] = useState(false);
 const [dragOver, setDragOver] = useState(false);
 const logoInputRef = useRef<HTMLInputElement>(null);
 const fileInputRef = useRef<HTMLInputElement>(null);
 const loadGenerationRef = useRef(0);

 const applyBody = (body: ProjectHomeData) => {
 setData(body);
 setName(body.project.name);
 setInstructions(body.project.instructions || "");
 setMemoryMode(body.project.memoryMode);
 setColor(body.project.color);
 setIcon(body.project.icon);
 setError("");
 };

 const load = useCallback((signal?: AbortSignal) => {
 const generation = loadGenerationRef.current;
 void fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: "no-store", signal })
 .then(async (response) => {
 const body = (await response.json().catch(() => ({}))) as ProjectHomeData & { error?: string };
 if (signal?.aborted || generation !== loadGenerationRef.current) return;
 if (!response.ok) throw new Error(body.error || "Could not load project.");
 applyBody(body);
 })
 .catch((cause) => {
 if (signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError") || (cause instanceof Error && cause.name === "AbortError")) return;
 setError(cause instanceof Error ? cause.message : "Could not load project.");
 });
 }, [projectId]);

 useLayoutEffect(() => {
 const controller = new AbortController();
 loadGenerationRef.current += 1;
 setData(null);
 setName("");
 setInstructions("");
 setError("");
 load(controller.signal);
 return () => controller.abort();
 }, [load]);

 async function save(patch: Record<string, unknown>) {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
   method: "PATCH",
   headers: { "Content-Type": "application/json" },
   body: JSON.stringify(patch),
  });
  if (response.ok) {
   window.dispatchEvent(new Event("metis:projects-changed"));
   load();
  }
 }

 async function uploadLogo(file: File) {
  setBusy(true);
  try {
   const dataUrl = await fileToBase64(file);
   const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/logo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, mimeType: file.type || "image/png", data: dataUrl }),
   });
   const body = (await response.json().catch(() => ({}))) as { error?: string };
   if (!response.ok) throw new Error(body.error || "Could not upload logo.");
   window.dispatchEvent(new Event("metis:projects-changed"));
   load();
  } catch (cause) {
   setError(cause instanceof Error ? cause.message : "Could not upload logo.");
  } finally {
   setBusy(false);
  }
 }

 async function uploadFiles(files: FileList | File[]) {
  const list = Array.from(files);
  if (!list.length) return;
  setBusy(true);
  setError("");
  try {
   for (const file of list) {
    if (file.size > MAX_PROJECT_FILE_BYTES) {
     setError(`${file.name} is larger than ${MAX_PROJECT_FILE_BYTES / 1024 / 1024}MB.`);
     continue;
    }
    const form = new FormData();
    form.set("file", file, file.name);
    form.set("name", file.name);
    if (file.type) form.set("mimeType", file.type);
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
              method: "POST",
              body: form,
            });
            if (!response.ok) {
              const fallback = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  name: file.name,
                  mimeType: file.type || undefined,
                  data: await fileToBase64(file),
                }),
              });
              if (!fallback.ok) {
                const body = (await fallback.json().catch(() => ({}))) as { error?: string };
                throw new Error(body.error || `Could not upload ${file.name}.`);
              }
            }
    }
   load();
  } catch (cause) {
   setError(cause instanceof Error ? cause.message : "Could not upload files.");
  } finally {
   setBusy(false);
  }
 }

 async function deleteProject() {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
  if (!response.ok) {
   const body = (await response.json().catch(() => ({}))) as { error?: string };
   throw new Error(body.error || "Could not delete project.");
  }
  window.dispatchEvent(new Event("metis:projects-changed"));
  onDeleted();
 }

 if (error && (!data || data.project.id !== projectId)) return <p className="p-6 text-sm text-destructive">{error}</p>;
 if (!data || data.project.id !== projectId) return <ProjectHomeSkeleton />;

 return (
  <div className="project-home-scroll mx-auto flex h-full min-h-0 w-full max-w-2xl flex-col gap-6 overflow-y-auto px-4 py-5 sm:gap-8 sm:px-6 sm:py-8">
   <header className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-4 sm:grid-cols-[3.5rem_minmax(0,1fr)_auto] sm:gap-4">
    <button
     type="button"
     className="group relative shrink-0"
     onClick={() => logoInputRef.current?.click()}
     aria-label="Upload custom logo"
    >
     <ProjectAvatar
      id={projectId}
      icon={icon}
      color={color}
      hasLogo={Boolean(data.project.logoStoredName)}
      updatedAt={data.project.updatedAt}
      size="lg"
     />
     <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100">
      <ImagePlus className="size-5" />
     </span>
    </button>
    <input
     ref={logoInputRef}
     type="file"
     accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
     className="hidden"
     onChange={(event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) void uploadLogo(file);
     }}
    />
    <div className="min-w-0 self-center sm:self-start">
     <Input
      className="h-auto min-w-0 border-none px-0 text-[1.35rem] font-semibold tracking-tight shadow-none focus-visible:ring-0 sm:text-2xl"
      value={name}
      onChange={(event) => setName(event.target.value)}
      onBlur={() => {
       if (name.trim() && name.trim() !== data.project.name) void save({ name: name.trim() });
      }}
     />
     <p className="mt-1 text-xs text-muted-foreground">
      {data.chats.length} chats · {data.files.length} files · {data.notes.length} notes
     </p>
    </div>
    <div className="col-span-2 grid grid-cols-2 gap-2 sm:col-span-1 sm:flex sm:shrink-0">
     <Button type="button" className="min-w-0" onClick={() => onNewChat(projectId)}>
      <Plus className="size-4" />
      New chat
     </Button>
     <Button type="button" variant="destructive" className="min-w-0" onClick={() => setDeleteOpen(true)}>
      <Trash2 className="size-4" />
      Delete
     </Button>
    </div>
   </header>

   {error ? <p className="text-sm text-destructive">{error}</p> : null}

   <section className="grid gap-3">
    <div className="flex items-center justify-between">
     <h3 className="text-sm font-medium">Appearance</h3>
     {data.project.logoStoredName ? (
      <Button
       type="button"
       variant="ghost"
       size="sm"
       onClick={() => {
        void fetch(`/api/projects/${encodeURIComponent(projectId)}/logo`, { method: "DELETE" }).then(() => {
         window.dispatchEvent(new Event("metis:projects-changed"));
         load();
        });
       }}
      >
       Remove logo
      </Button>
     ) : null}
    </div>
    <div className="flex flex-wrap gap-1.5">
     {PROJECT_COLORS.map((value) => (
      <button
       key={value}
       type="button"
       className={cn("size-7 rounded-full border-2", color === value ? "border-foreground" : "border-transparent")}
       style={{ backgroundColor: value }}
       onClick={() => {
        setColor(value);
        void save({ color: value });
       }}
      />
     ))}
    </div>
    <div className="flex flex-wrap gap-1.5">
     {PROJECT_ICONS.map((value) => (
      <button
       key={value}
       type="button"
       className={cn(
        "inline-flex size-9 items-center justify-center rounded-xl text-white",
        icon === value ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : "opacity-80 hover:opacity-100",
       )}
       style={{ backgroundColor: color }}
       aria-label={value}
       onClick={() => {
        setIcon(value);
        void save({ icon: value });
       }}
      >
       <ProjectIconGlyph icon={value} className="size-4" />
      </button>
     ))}
    </div>
   </section>

   <section className="grid gap-2">
    <h3 className="text-sm font-medium">Project instructions</h3>
    <p className="text-xs text-muted-foreground">Override global custom instructions while a chat is in this project.</p>
    <Textarea
     value={instructions}
     onChange={(event) => setInstructions(event.target.value)}
     onBlur={() => void save({ instructions })}
     placeholder="How the agent should work in this project…"
     rows={6}
     className="min-h-32 rounded-xl"
    />
   </section>

   <section className="grid gap-2">
    <h3 className="text-sm font-medium">Memory</h3>
    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
     {(["default", "project_only"] as const).map((mode) => (
      <Button
       key={mode}
       type="button"
       variant={memoryMode === mode ? "default" : "outline"}
       className="min-w-0 px-2.5 text-xs sm:px-4 sm:text-sm"
       onClick={() => {
        setMemoryMode(mode);
        void save({ memoryMode: mode });
       }}
      >
       {mode === "default" ? "Default (include global)" : "Project only"}
      </Button>
     ))}
    </div>
   </section>

   <section className="grid gap-3">
    <h3 className="text-sm font-medium">Files</h3>
    <div
      role="button"
      tabIndex={0}
      className={cn(
        "relative flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-8 text-center transition-colors",
        dragOver ? "border-foreground/40 bg-white/[0.04]" : "border-border/70 hover:border-foreground/25 hover:bg-white/[0.02]",
      )}
      onClick={() => fileInputRef.current?.click()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          fileInputRef.current?.click();
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        if (event.dataTransfer.files.length) void uploadFiles(event.dataTransfer.files);
      }}
    >
      <Upload className="size-5 text-muted-foreground" />
      <div className="text-sm text-muted-foreground">
        {busy ? "Uploading…" : "Drop files here or click to upload"}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          const files = event.target.files;
          event.target.value = "";
          if (files?.length) void uploadFiles(files);
        }}
      />
    </div>
    <ul className="grid gap-1">
     {data.files.map((file) => (
      <li key={file.id} className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-muted/40">
       <a
        href={`/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(file.id)}`}
        className="min-w-0 flex-1 truncate text-sm hover:underline"
        target="_blank"
        rel="noreferrer"
       >
        {file.name}
        <span className="ml-2 text-xs text-muted-foreground">{formatBytes(file.size)}</span>
       </a>
       <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete ${file.name}`}
        onClick={() => {
         void fetch(`/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(file.id)}`, {
          method: "DELETE",
         }).then(() => load());
        }}
       >
        <X className="size-3.5" />
       </Button>
      </li>
     ))}
    </ul>
   </section>

   <section className="grid gap-2 pb-10">
    <h3 className="text-sm font-medium">Notes</h3>
    {data.notes.length === 0 ? (
     <button
      type="button"
      className="flex items-center gap-2 rounded-xl px-2 py-2 text-left text-sm text-muted-foreground hover:bg-muted/40"
      onClick={() => onOpenNotes()}
     >
      <StickyNote className="size-3.5" />
      Open notes
     </button>
    ) : (
     <ul className="grid gap-1 text-sm">
      {data.notes.map((note) => (
       <li key={note.id}>
        <button type="button" className="w-full rounded-xl px-2 py-1.5 text-left hover:bg-muted/40" onClick={() => onOpenNotes(note.id)}>
         {note.title || "Untitled note"}
        </button>
       </li>
      ))}
     </ul>
    )}
   </section>

   <ConfirmDialog
    open={deleteOpen}
    onOpenChange={setDeleteOpen}
    title={`Delete ${data.project.name}?`}
    description="Chats stay, but they leave this project. Files and the custom logo are removed."
    confirmLabel="Delete project"
    onConfirm={deleteProject}
   />
  </div>
 );
}
