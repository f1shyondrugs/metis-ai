"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Puzzle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type SkillItem = {
  id: string;
  title: string;
  description: string;
  source: string;
  sourceType: string;
  skillPath: string;
  enabled: boolean;
  alwaysOn: boolean;
};

export function SkillsSettings() {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [manualId, setManualId] = useState("");
  const [manualContent, setManualContent] = useState("");
  const [manualFile, setManualFile] = useState<File | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    void fetch("/api/skills", { cache: "no-store" }).then(async (response) => {
      const body = (await response.json().catch(() => ({}))) as { skills?: SkillItem[]; error?: string };
      if (!response.ok) throw new Error(body.error || "Could not load skills.");
      setSkills(body.skills || []);
      setError("");
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load skills."));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function patchSkill(id: string, payload: { enabledSkills?: Record<string, boolean>; alwaysOnSkills?: Record<string, boolean> }) {
    setBusyId(id);
    try {
      const response = await fetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => ({}))) as { skills?: SkillItem[]; error?: string };
      if (!response.ok) throw new Error(body.error || "Could not update skill.");
      setSkills(body.skills || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update skill.");
    } finally {
      setBusyId(null);
    }
  }

  async function openPreview(id: string) {
    if (previewId === id) {
      setPreviewId(null);
      setPreview("");
      return;
    }
    const response = await fetch(`/api/skills?read=${encodeURIComponent(id)}`, { cache: "no-store" });
    const body = (await response.json().catch(() => ({}))) as { content?: string; error?: string };
    if (!response.ok) {
      setError(body.error || "Could not read skill file.");
      return;
    }
    setPreviewId(id);
    setPreview(body.content || "");
    setError("");
  }

  async function addSkill() {
    setAdding(true);
    setError("");
    try {
      const form = new FormData();
      form.set("id", manualId);
      if (manualFile) form.set("file", manualFile);
      else form.set("content", manualContent);
      const response = await fetch("/api/skills", { method: "POST", body: form });
      const body = (await response.json().catch(() => ({}))) as { skills?: SkillItem[]; error?: string };
      if (!response.ok) throw new Error(body.error || "Could not add skill.");
      setSkills(body.skills || []);
      setManualId("");
      setManualContent("");
      setManualFile(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add skill.");
    } finally {
      setAdding(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-medium"><Puzzle className="size-4" /> Skills</h3>
        <p className="mt-1 text-xs text-muted-foreground">Installed skills from skills-lock.json. Open a skill to change Always on. Enabled skills stay available; Always on injects the skill into every chat.</p>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="grid gap-2 rounded-xl border border-border/60 p-3">
        <p className="text-sm font-medium">Add manual skill</p>
        <input className="h-8 rounded-md border bg-background px-2 text-sm" placeholder="Skill id (for example, my-skill)" value={manualId} onChange={(event) => setManualId(event.target.value)} />
        <input type="file" accept=".md,text/markdown" className="text-xs" onChange={(event) => {
          const file = event.target.files?.[0] || null;
          setManualFile(file);
          if (file && !manualId) setManualId(file.name.replace(/\.md$/i, ""));
        }} />
        <textarea className="min-h-28 rounded-md border bg-background p-2 font-mono text-xs" placeholder="Paste SKILL.md content" value={manualContent} onChange={(event) => {
          setManualContent(event.target.value);
          setManualFile(null);
        }} />
        <Button type="button" size="sm" className="w-fit" disabled={adding || !manualId.trim() || (!manualFile && !manualContent.trim())} onClick={() => void addSkill()}>{adding ? "Adding…" : "Add skill"}</Button>
      </div>
      {skills.length === 0 ? (
        <p className="text-sm text-muted-foreground">No skills installed.</p>
      ) : (
        <ul className="divide-y rounded-xl border border-border/60">
          {skills.map((skill) => {
            const open = openId === skill.id;
            return (
              <li key={skill.id} className="min-w-0">
                <Collapsible open={open} onOpenChange={(next) => {
                  setOpenId(next ? skill.id : null);
                  if (!next && previewId === skill.id) {
                    setPreviewId(null);
                    setPreview("");
                  }
                }}>
                  <div className="flex min-w-0 items-center gap-2 px-3 py-2.5">
                    <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                      <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium" title={skill.title}>{skill.title}</p>
                        <p className="truncate text-xs text-muted-foreground" title={skill.alwaysOn ? "Always on" : "Match-based"}>
                          {skill.alwaysOn ? "Always on" : "Match-based"}
                          {skill.enabled ? "" : " · disabled"}
                        </p>
                      </div>
                    </CollapsibleTrigger>
                    <Switch
                      className="shrink-0"
                      checked={skill.enabled}
                      disabled={busyId === skill.id}
                      onCheckedChange={(checked) => void patchSkill(skill.id, { enabledSkills: { [skill.id]: checked } })}
                      aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.title}`}
                    />
                  </div>
                  <CollapsibleContent className="px-3 pb-3">
                    <div className="ml-6 grid gap-3 border-l border-border/60 pl-3">
                      {skill.description ? <p className="text-xs leading-relaxed text-muted-foreground">{skill.description}</p> : null}
                      <p className="truncate text-[11px] text-muted-foreground" title={`${skill.source} · ${skill.skillPath}`}>{skill.source}</p>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm">Always on</p>
                          <p className="text-[11px] text-muted-foreground">Inject into every chat. Off = only when the task matches.</p>
                        </div>
                        <Switch
                          className="shrink-0"
                          checked={skill.alwaysOn}
                          disabled={busyId === skill.id}
                          onCheckedChange={(checked) => void patchSkill(skill.id, { alwaysOnSkills: { [skill.id]: checked } })}
                          aria-label={`${skill.alwaysOn ? "Disable" : "Enable"} always on for ${skill.title}`}
                        />
                      </div>
                      <Button type="button" size="xs" variant="ghost" className="w-fit px-0" onClick={() => void openPreview(skill.id)}>{previewId === skill.id ? "Hide preview" : "Preview"}</Button>
                      {previewId === skill.id ? <pre className="max-h-64 overflow-auto rounded-lg bg-muted/40 p-3 text-[11px] leading-relaxed whitespace-pre-wrap">{preview}</pre> : null}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
