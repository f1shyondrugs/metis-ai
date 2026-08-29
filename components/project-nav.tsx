"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { FolderPlus, Plus } from "lucide-react";
import { ProjectAvatar, ProjectIconGlyph } from "@/components/project-avatar";
import { Button } from "@/components/ui/button";
import {
 Dialog,
 DialogContent,
 DialogFooter,
 DialogHeader,
 DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PROJECT_COLORS, PROJECT_ICONS } from "@/lib/project-constants";
import { cn } from "@/lib/utils";

export type SidebarProject = {
 id: string;
 name: string;
 icon: string;
 color: string;
 logoStoredName?: string;
 updatedAt?: string;
};

export type SidebarChat = {
 id: string;
 title: string;
 projectId?: string;
 pinned?: boolean;
 archived?: boolean;
 incognito?: boolean;
};

export function ProjectNav({
 chats,
 activeChatId,
 activeProjectId,
 notesOpen,
 renderChat,
 onNewChat,
 onOpenProject,
 onClearProject,
 onMoveChat,
  onCollapseNav,
  onOverlayOpen,
}: {
 chats: SidebarChat[];
 activeChatId?: string | null;
 activeProjectId?: string | null;
 notesOpen?: boolean;
 renderChat: (chat: SidebarChat) => ReactNode;
 onNewChat: (projectId?: string | null) => void;
 onOpenProject: (projectId: string) => void;
 onClearProject: () => void;
 onMoveChat: (chatId: string, projectId: string | null) => void;
  onCollapseNav?: () => void;
  onOverlayOpen?: () => void;
}) {
 const [projects, setProjects] = useState<SidebarProject[]>([]);
 const [createOpen, setCreateOpen] = useState(false);
 const [name, setName] = useState("");
 const [icon, setIcon] = useState<string>(PROJECT_ICONS[0]);
 const [color, setColor] = useState(PROJECT_COLORS[0]);
 const [draggingId, setDraggingId] = useState<string | null>(null);

 const load = useCallback(() => {
  void fetch("/api/projects", { cache: "no-store" })
   .then(async (response) => {
    const body = (await response.json().catch(() => ({}))) as { projects?: SidebarProject[] };
    if (response.ok) setProjects(body.projects || []);
   })
   .catch(() => undefined);
 }, []);

 useEffect(() => {
  load();
  const refresh = () => load();
  window.addEventListener("metis:projects-changed", refresh);
  return () => window.removeEventListener("metis:projects-changed", refresh);
 }, [load]);

 const visibleChats = useMemo(() => {
  return chats.filter((chat) => {
   if (chat.archived) return false;
   if (!activeProjectId) return !chat.projectId;
   return chat.projectId === activeProjectId;
  });
 }, [chats, activeProjectId]);

 async function create() {
  const response = await fetch("/api/projects", {
   method: "POST",
   headers: { "Content-Type": "application/json" },
   body: JSON.stringify({ name: name.trim() || "New project", icon, color }),
  });
  const body = (await response.json().catch(() => ({}))) as { project?: SidebarProject };
  if (!response.ok || !body.project) return;
  setCreateOpen(false);
  setName("");
  load();
  window.dispatchEvent(new Event("metis:projects-changed"));
  onOpenProject(body.project.id);
 onCollapseNav?.();
 }

  function openCreate() {
    setCreateOpen(true);
  }

 function droppable(projectId: string | null, children: ReactNode, key?: string) {
  return (
   <div
    key={key}
    onDragOver={(event) => {
     if (draggingId) event.preventDefault();
    }}
    onDrop={(event) => {
     event.preventDefault();
     if (draggingId) onMoveChat(draggingId, projectId);
     setDraggingId(null);
    }}
   >
    {children}
   </div>
  );
 }

 const allSelected = !activeProjectId;

 return (
  <div className="space-y-3">
   <div className="flex items-center justify-between px-2.5">
    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Projects</p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-6"
          aria-label="New project"
          onClick={() => {
            onOverlayOpen?.();
            openCreate();
          }}
        >
     <FolderPlus className="size-3.5" />
    </Button>
   </div>
   <div className="flex flex-wrap gap-1.5 px-1.5">
    {droppable(
     null,
     <button
      type="button"
      className={cn(
       "rounded-full px-2.5 py-1 text-[12px] transition-colors",
       allSelected
        ? "bg-white/[0.10] text-foreground ring-1 ring-foreground/20"
        : "bg-white/[0.04] text-muted-foreground hover:bg-white/[0.07] hover:text-foreground",
      )}
      aria-pressed={allSelected}
      onClick={onClearProject}
     >
      All
     </button>,
    )}
    {projects.map((project) => {
     const selected = activeProjectId === project.id;
     return (
      <div key={project.id}>
      {droppable(
      project.id,
      <button
       type="button"
       className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5 text-[12px] transition-colors",
        selected
         ? "bg-white/[0.10] text-foreground ring-1 ring-foreground/20"
         : "bg-white/[0.04] text-muted-foreground hover:bg-white/[0.07] hover:text-foreground",
       )}
       aria-pressed={selected}
       onClick={() => onOpenProject(project.id)}
       title={project.name}
      >
       <ProjectAvatar
        id={project.id}
        icon={project.icon}
        color={project.color}
        hasLogo={Boolean(project.logoStoredName)}
        updatedAt={project.updatedAt}
        className="size-4 rounded-full"
       />
       <span className="min-w-0 truncate">{project.name}</span>
      </button>,
      )}
      </div>
     );
    })}
   </div>
   {droppable(
    activeProjectId || null,
    <div className="space-y-1">
     <div className="flex items-center justify-between px-2.5 pt-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
       {activeProjectId ? projects.find((project) => project.id === activeProjectId)?.name || "Chats" : "Chats"}
      </p>
      <Button
       type="button"
       variant="ghost"
       size="icon-sm"
       className="size-6"
       aria-label={activeProjectId ? "New chat in project" : "New chat"}
       onClick={() => onNewChat(activeProjectId)}
      >
       <Plus className="size-3.5" />
      </Button>
     </div>
     {visibleChats.length === 0 ? (
      <p className="px-2.5 py-3 text-xs text-muted-foreground/70">
       {activeProjectId ? "No chats in this project" : "No chats yet"}
      </p>
     ) : (
      visibleChats.map((chat) => (
       <div
        key={chat.id}
        draggable={!chat.incognito}
        onDragStart={() => { if (!chat.incognito) setDraggingId(chat.id); }}
        onDragEnd={() => setDraggingId(null)}
       >
        {renderChat(chat)}
       </div>
      ))
     )}
    </div>,
   )}
   <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) onCollapseNav?.(); }}>
    <DialogContent className="sm:max-w-md">
     <DialogHeader>
      <DialogTitle>New project</DialogTitle>
     </DialogHeader>
     <div className="grid gap-4">
      <label className="grid gap-1.5 text-xs text-muted-foreground">
       Name
       <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Research, Website, …" />
      </label>
      <div className="grid gap-1.5">
       <p className="text-xs text-muted-foreground">Color</p>
       <div className="flex flex-wrap gap-1.5">
        {PROJECT_COLORS.map((value) => (
         <button
          key={value}
          type="button"
          className={cn("size-7 rounded-full border-2", color === value ? "border-foreground" : "border-transparent")}
          style={{ backgroundColor: value }}
          aria-label={`Color ${value}`}
          onClick={() => setColor(value)}
         />
        ))}
       </div>
      </div>
      <div className="grid gap-1.5">
       <p className="text-xs text-muted-foreground">Icon</p>
       <div className="flex flex-wrap gap-1.5">
        {PROJECT_ICONS.map((value) => (
         <button
          key={value}
          type="button"
          className={cn(
           "inline-flex size-8 items-center justify-center rounded-lg text-white",
           icon === value ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : "opacity-80 hover:opacity-100",
          )}
          style={{ backgroundColor: color }}
          aria-label={value}
          onClick={() => setIcon(value)}
         >
          <ProjectIconGlyph icon={value} className="size-3.5" />
         </button>
        ))}
       </div>
      </div>
     </div>
     <DialogFooter>
      <Button type="button" variant="outline" onClick={() => { setCreateOpen(false); onCollapseNav?.(); }}>Cancel</Button>
      <Button type="button" onClick={() => void create()}>Create</Button>
     </DialogFooter>
    </DialogContent>
   </Dialog>
  </div>
 );
}
