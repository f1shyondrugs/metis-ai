"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Globe2,
  LoaderCircle,
  MoreHorizontal,
  Network,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  TimerReset,
  Trash2,
  UserRound,
  Wrench,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { NoteProjectMenu, type NoteProjectOption } from "@/components/note-project-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ModelInfo } from "@/components/settings-panel";
import type { AgentMode } from "@/lib/store";
import { cn } from "@/lib/utils";

type AutomationGraphNode = {
  id: string;
  kind: "trigger" | "agent" | "tools";
  label: string;
  x: number;
  y: number;
  config?: Record<string, unknown>;
};

type AutomationGraph = {
  version: 1;
  nodes: AutomationGraphNode[];
  edges: Array<{ id: string; source: string; target: string }>;
};

type AutomationRun = {
  id: string;
  jobId?: string;
  chatId: string;
  trigger?: "scheduled" | "manual";
  status: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  resultPreview?: string;
  error?: string;
  manual?: boolean;
};

type Automation = {
  id: string;
  chatId: string;
  chatTitle?: string;
  projectId?: string;
  name: string;
  prompt: string;
  creator?: "user" | "agent";
  modeId?: string;
  modelId?: string;
  extendedModelId?: string;
  maxRunMinutes?: number;
  graph?: AutomationGraph;
  schedule:
    | { kind: "once"; at: string }
    | { kind: "interval"; everyMinutes: number }
    | { kind: "days"; everyDays: number }
    | { kind: "monthly"; dayOfMonth: number };
  timezone: string;
  status: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastError?: string;
  runs?: AutomationRun[];
};

type AutomationsPanelProps = {
  activeChatId?: string | null;
  activeProjectId?: string | null;
  onOpenChat: (chatId: string) => void;
  models: ModelInfo[];
  modes: AgentMode[];
  selectedModelId?: string;
  highlightId?: string | null;
};

function dateText(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function durationText(start?: string, end?: string) {
  if (!start) return "";
  const from = Date.parse(start);
  const to = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return "";
  const seconds = Math.max(1, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function runLimitText(minutes = 1440) {
  if (minutes < 60) return `${minutes} min`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function scheduleText(automation: Automation) {
  if (automation.schedule.kind === "once") return `Once · ${dateText(automation.schedule.at)}`;
  if (automation.schedule.kind === "days") return `Every ${automation.schedule.everyDays} day${automation.schedule.everyDays === 1 ? "" : "s"}`;
  if (automation.schedule.kind === "monthly") return `Monthly · day ${automation.schedule.dayOfMonth}`;
  if (automation.schedule.everyMinutes % 1440 === 0) return `Every ${automation.schedule.everyMinutes / 1440} day${automation.schedule.everyMinutes === 1440 ? "" : "s"}`;
  if (automation.schedule.everyMinutes % 60 === 0) return `Every ${automation.schedule.everyMinutes / 60}h`;
  return `Every ${automation.schedule.everyMinutes}m`;
}

function statusTone(status: string) {
  if (status === "active" || status === "completed") return "text-emerald-400";
  if (status === "error") return "text-destructive";
  return "text-muted-foreground";
}

function runTone(status: string) {
  if (status === "completed") return "bg-emerald-400";
  if (status === "error" || status === "cancelled") return "bg-destructive";
  if (status === "running") return "bg-blue-400";
  return "bg-amber-400";
}

function nodeIcon(kind: AutomationGraphNode["kind"]) {
  if (kind === "trigger") return CalendarClock;
  if (kind === "agent") return Bot;
  return Wrench;
}

function fallbackGraph(automation: Automation): AutomationGraph {
  return {
    version: 1,
    nodes: [
      { id: "trigger", kind: "trigger", label: "Trigger", x: 24, y: 48 },
      { id: "agent", kind: "agent", label: "Agent", x: 216, y: 48 },
      { id: "tools", kind: "tools", label: "Tools & MCPs", x: 408, y: 48 },
    ],
    edges: [
      { id: "trigger-agent", source: "trigger", target: "agent" },
      { id: "agent-tools", source: "agent", target: "tools" },
    ],
  };
}

function AutomationGraphView({ automation }: { automation: Automation }) {
  const graph = automation.graph || fallbackGraph(automation);
  const [selectedNodeId, setSelectedNodeId] = useState(graph.nodes[0]?.id || "");
  const selected = graph.nodes.find((node) => node.id === selectedNodeId) || graph.nodes[0];
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));

  useEffect(() => {
    if (!graph.nodes.some((node) => node.id === selectedNodeId)) setSelectedNodeId(graph.nodes[0]?.id || "");
  }, [graph, selectedNodeId]);

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border border-border/40 bg-background/45">
        <div className="relative h-[154px] min-w-[590px]" aria-label="Automation flow">
          <svg className="pointer-events-none absolute inset-0 h-full w-full text-border" viewBox="0 0 590 154" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <marker id={`automation-arrow-${automation.id}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
              </marker>
            </defs>
            {graph.edges.map((edge) => {
              const source = nodeMap.get(edge.source);
              const target = nodeMap.get(edge.target);
              if (!source || !target) return null;
              return (
                <line
                  key={edge.id}
                  x1={source.x + 144}
                  y1={source.y + 34}
                  x2={target.x - 10}
                  y2={target.y + 34}
                  stroke="currentColor"
                  strokeWidth="1.5"
                  markerEnd={`url(#automation-arrow-${automation.id})`}
                />
              );
            })}
          </svg>
          {graph.nodes.map((node) => {
            const Icon = nodeIcon(node.kind);
            const active = node.id === selected?.id;
            return (
              <button
                key={node.id}
                type="button"
                onClick={() => setSelectedNodeId(node.id)}
                className={`absolute w-36 rounded-xl border px-3 py-2.5 text-left shadow-sm transition ${active ? "border-primary/45 bg-primary/10" : "border-border/50 bg-card hover:bg-muted/60"}`}
                style={{ left: node.x, top: node.y }}
              >
                <span className="flex items-center gap-2 text-[11px] font-semibold">
                  <span className="grid size-6 place-items-center rounded-md border border-border/50 bg-background/70"><Icon className="size-3.5" /></span>
                  <span className="truncate">{node.label}</span>
                </span>
                <span className="mt-1.5 block truncate text-[9px] text-muted-foreground">
                  {node.kind === "trigger" ? scheduleText(automation) : node.kind === "agent" ? `${automation.modeId || "agent"} · ${runLimitText(automation.maxRunMinutes)}` : "Browser · MCPs · tools"}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {selected ? (
        <div className="rounded-lg border border-border/35 bg-card/35 px-2.5 py-2 text-[10px] text-muted-foreground">
          {selected.kind === "trigger" ? (
            <span><strong className="font-medium text-foreground">Trigger</strong> · {scheduleText(automation)} · {automation.timezone || "UTC"}</span>
          ) : selected.kind === "agent" ? (
            <span><strong className="font-medium text-foreground">Agent</strong> · {automation.modeId || "agent"} · max {runLimitText(automation.maxRunMinutes)} · {automation.modelId || "default model"}</span>
          ) : (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><strong className="font-medium text-foreground">Full tool surface</strong><span className="inline-flex items-center gap-1"><Network className="size-3" />all MCPs</span><span className="inline-flex items-center gap-1"><Globe2 className="size-3" />persistent browser</span><span>remote + subagents</span></span>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function AutomationsPanel({ activeChatId, activeProjectId, onOpenChat, models, modes, selectedModelId, highlightId }: AutomationsPanelProps) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [detailAutomation, setDetailAutomation] = useState<Automation | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [scheduleKind, setScheduleKind] = useState<"once" | "interval" | "days" | "monthly">("interval");
  const [onceAt, setOnceAt] = useState("");
  const [everyMinutes, setEveryMinutes] = useState("60");
  const [everyDays, setEveryDays] = useState("1");
  const [dayOfMonth, setDayOfMonth] = useState("1");
  const [chatId, setChatId] = useState(activeChatId || "");
  const [modeId, setModeId] = useState("agent");
  const [modelId, setModelId] = useState(selectedModelId || "");
  const [extendedModelId, setExtendedModelId] = useState("");
  const [maxRunMinutes, setMaxRunMinutes] = useState("1440");
  const [search, setSearch] = useState("");
  const [projects, setProjects] = useState<NoteProjectOption[]>([]);
  const [formProjectId, setFormProjectId] = useState<string | null>(activeProjectId || null);

  const load = async (silent = false) => {
    try {
      const response = await fetch("/api/automations", { cache: "no-store" });
      const data = (await response.json()) as { automations?: Automation[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not load automations");
      setAutomations(data.automations || []);
      if (detailAutomation) {
        const compact = data.automations?.find((item) => item.id === detailAutomation.id);
        if (compact) setDetailAutomation((current) => current ? { ...current, ...compact, runs: current.runs } : compact);
      }
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "Could not load automations");
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (id: string, silent = false) => {
    if (!silent) setDetailLoading(true);
    try {
      const response = await fetch(`/api/automations/${id}`, { cache: "no-store" });
      const data = (await response.json()) as { automation?: Automation; error?: string };
      if (!response.ok || !data.automation) throw new Error(data.error || "Could not load automation");
      setDetailAutomation(data.automation);
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "Could not load automation");
    } finally {
      if (!silent) setDetailLoading(false);
    }
  };

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
    window.addEventListener("metis:projects-changed", loadProjects);
    return () => window.removeEventListener("metis:projects-changed", loadProjects);
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      void load(true);
      if (detailAutomation?.id) void loadDetail(detailAutomation.id, true);
    }, 5_000);
    return () => window.clearInterval(timer);
    // detail id is intentionally the only changing dependency for polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailAutomation?.id]);

  useEffect(() => {
    if (!highlightId) return;
    void (async () => {
      await load(true);
      await loadDetail(highlightId);
      window.requestAnimationFrame(() => {
        document.getElementById(`automation-${highlightId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    })();
  }, [highlightId]);

  const latestCompleted = useMemo(
    () => automations.flatMap((automation) => (automation.runs || []).map((run) => ({ automation, run })))
      .filter(({ run }) => run.status === "completed")
      .sort((a, b) => Date.parse(b.run.completedAt || b.run.createdAt) - Date.parse(a.run.completedAt || a.run.createdAt))[0],
    [automations],
  );

  useEffect(() => {
    if (!latestCompleted || !latestCompleted.run.completedAt) return;
    const key = `automation-notified:${latestCompleted.run.id}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
    toast.success(`Automation completed: ${latestCompleted.automation.name}`, {
      description: "The run transcript is ready in Automations.",
    });
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(`Automation completed: ${latestCompleted.automation.name}`, {
        body: "Open Automations to inspect the complete run chat.",
      });
    }
  }, [latestCompleted]);

  function resetForm() {
    setEditingId(null);
    setName("");
    setPrompt("");
    setScheduleKind("interval");
    setOnceAt("");
    setEveryMinutes("60");
    setEveryDays("1");
    setDayOfMonth("1");
    setChatId(activeChatId || "");
    setModeId("agent");
    setModelId(selectedModelId || models[0]?.id || "");
    setExtendedModelId("");
    setMaxRunMinutes("1440");
    setFormProjectId(activeProjectId || null);
    setFormOpen(false);
  }

  function editAutomation(automation: Automation) {
    setFormOpen(true);
    setEditingId(automation.id);
    setName(automation.name);
    setPrompt(automation.prompt);
    setChatId(automation.chatId);
    setModeId(automation.modeId || "agent");
    setModelId(automation.modelId || selectedModelId || models[0]?.id || "");
    setExtendedModelId(automation.extendedModelId || "");
    setMaxRunMinutes(String(automation.maxRunMinutes || 1440));
    setFormProjectId(automation.projectId || null);
    if (automation.schedule.kind === "once") {
      setScheduleKind("once");
      setOnceAt(automation.schedule.at.slice(0, 16));
    } else if (automation.schedule.kind === "days") {
      setScheduleKind("days");
      setEveryDays(String(automation.schedule.everyDays));
    } else if (automation.schedule.kind === "monthly") {
      setScheduleKind("monthly");
      setDayOfMonth(String(automation.schedule.dayOfMonth));
    } else {
      setScheduleKind("interval");
      setEveryMinutes(String(automation.schedule.everyMinutes));
    }
  }

  async function saveAutomation(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const schedule = scheduleKind === "once"
        ? { kind: "once", at: new Date(onceAt).toISOString() }
        : scheduleKind === "days"
          ? { kind: "days", everyDays: Number(everyDays) }
          : scheduleKind === "monthly"
            ? { kind: "monthly", dayOfMonth: Number(dayOfMonth) }
            : { kind: "interval", everyMinutes: Number(everyMinutes) };
      const response = await fetch(editingId ? `/api/automations/${editingId}` : "/api/automations", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          prompt,
          chatId: chatId || activeChatId,
          modeId,
          modelId,
          extendedModelId: extendedModelId || undefined,
          maxRunMinutes: Number(maxRunMinutes),
          schedule,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          projectId: formProjectId,
        }),
      });
      const data = (await response.json()) as { automation?: Automation; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not save automation");
      toast.success(editingId ? "Automation updated" : "Automation created");
      const savedId = editingId || data.automation?.id;
      resetForm();
      await load(true);
      if (savedId && detailAutomation?.id === savedId) await loadDetail(savedId, true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save automation");
    } finally {
      setSaving(false);
    }
  }

  async function action(id: string, method: "PATCH" | "DELETE", body?: Record<string, unknown>) {
    const response = await fetch(`/api/automations/${id}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string; chatId?: string };
    if (!response.ok) throw new Error(data.error || "Automation action failed");
    await load(true);
    if (method === "DELETE") {
      if (detailAutomation?.id === id) setDetailAutomation(null);
    } else if (detailAutomation?.id === id) {
      await loadDetail(id, true);
    }
    return data;
  }

  async function runNow(automation: Automation) {
    setRunningId(automation.id);
    try {
      const data = await action(automation.id, "PATCH", { action: "run" });
      toast.success(`Running “${automation.name}”`);
      if (data.chatId) onOpenChat(data.chatId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not run automation");
    } finally {
      setRunningId(null);
    }
  }

  const visibleAutomations = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const projectNameById = new Map(projects.map((project) => [project.id, project.name.toLocaleLowerCase()]));
    return automations.filter((automation) => {
      if (!query) return true;
      if (automation.name.toLocaleLowerCase().includes(query)) return true;
      if (automation.prompt.toLocaleLowerCase().includes(query)) return true;
      if ((automation.chatTitle || "").toLocaleLowerCase().includes(query)) return true;
      const projectName = automation.projectId ? projectNameById.get(automation.projectId) : undefined;
      return Boolean(projectName?.includes(query));
    });
  }, [automations, projects, search]);

  const currentDetail = detailAutomation;

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
      <div className="sticky top-0 z-10 flex items-center justify-between rounded-xl border border-border/40 bg-background/90 px-3 py-2.5 backdrop-blur">
        {currentDetail ? (
          <button type="button" onClick={() => setDetailAutomation(null)} className="flex min-w-0 items-center gap-2 text-xs font-medium hover:text-primary">
            <ArrowLeft className="size-4 shrink-0" />
            <span className="truncate">Automations</span>
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="hidden items-center gap-2 text-xs font-medium sm:flex"><CalendarClock className="size-4 text-primary" />Automations</span>
            <div className="relative min-w-32 flex-1 sm:max-w-56">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search automations" className="h-7 pl-7 text-xs" />
            </div>
          </div>
        )}
        <Button type="button" size="icon-xs" variant="ghost" title="New automation" onClick={() => { resetForm(); setFormOpen(true); }}>
          <Plus className="size-4" />
        </Button>
      </div>

      <Dialog open={formOpen} onOpenChange={(open) => { setFormOpen(open); if (!open) setEditingId(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>{editingId ? "Edit automation" : "New automation"}</DialogTitle></DialogHeader>
          <form onSubmit={saveAutomation} className="space-y-3">
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Automation name" required />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-medium text-muted-foreground">Project</p>
            <NoteProjectMenu projectId={formProjectId} projects={projects} onChange={setFormProjectId} />
          </div>
            <Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="What should the agent do?" className="min-h-28" required />
            <div className="space-y-1">
              <p className="text-[10px] font-medium text-muted-foreground">Context chat</p>
              <Input value={chatId} onChange={(event) => setChatId(event.target.value)} placeholder={activeChatId ? "Current chat will seed context + browser state" : "Optional chat ID"} className="font-mono text-xs" />
              <p className="text-[9px] text-muted-foreground">Each run gets its own persistent chat. The context chat only seeds context and browser session state.</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select value={modeId} onChange={(event) => setModeId(event.target.value)} className="h-9 rounded-md border bg-background px-2 text-xs" aria-label="AI mode">
                {modes.map((mode) => <option key={mode.id} value={mode.id}>{mode.name}</option>)}
              </select>
              <select value={modelId} onChange={(event) => setModelId(event.target.value)} className="h-9 min-w-0 rounded-md border bg-background px-2 text-xs" aria-label="Model">
                <option value="">Default model</option>
                {models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
              </select>
            </div>
            <select value={extendedModelId} onChange={(event) => setExtendedModelId(event.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-xs" aria-label="Extended model">
              <option value="">Default extended/subagent model</option>
              {models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <p className="text-[10px] font-medium text-muted-foreground">Schedule</p>
                <select value={scheduleKind} onChange={(event) => setScheduleKind(event.target.value as "once" | "interval" | "days" | "monthly")} className="h-9 w-full rounded-md border bg-background px-2 text-xs">
                  <option value="interval">Every X minutes</option>
                  <option value="days">Every X days</option>
                  <option value="monthly">Monthly day</option>
                  <option value="once">One-time</option>
                </select>
              </div>
              <div className="space-y-1">
                <p className="text-[10px] font-medium text-muted-foreground">Timing</p>
                {scheduleKind === "once" ? (
                  <Input type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} className="h-9 text-xs" required />
                ) : scheduleKind === "days" ? (
                  <Input type="number" min="1" step="1" value={everyDays} onChange={(event) => setEveryDays(event.target.value)} className="h-9 text-xs" placeholder="Days" required />
                ) : scheduleKind === "monthly" ? (
                  <Input type="number" min="1" max="31" step="1" value={dayOfMonth} onChange={(event) => setDayOfMonth(event.target.value)} className="h-9 text-xs" placeholder="Day 1–31" required />
                ) : (
                  <Input type="number" min="60" step="1" value={everyMinutes} onChange={(event) => setEveryMinutes(event.target.value)} className="h-9 text-xs" required />
                )}
              </div>
            </div>
            <div className="rounded-lg border border-border/40 bg-card/35 p-2.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-medium">Maximum run time</p>
                  <p className="text-[9px] text-muted-foreground">For small tasks or multi-day autonomous work.</p>
                </div>
                <div className="flex items-center gap-1.5"><TimerReset className="size-3.5 text-muted-foreground" /><Input type="number" min="5" max="10080" step="1" value={maxRunMinutes} onChange={(event) => setMaxRunMinutes(event.target.value)} className="h-8 w-24 text-xs" required /><span className="text-[10px] text-muted-foreground">min</span></div>
              </div>
            </div>
            <div className="rounded-lg border border-border/40 px-2.5 py-2 text-[9px] text-muted-foreground">
              Agent mode has the full Metis tool surface: persistent browser, all enabled MCPs, remote tools, files, memory, terminal and subagents. Interactive confirmation tools are skipped during unattended runs.
            </div>
            <Button type="submit" className="w-full" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Create automation"}</Button>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete automation?"
        description={deleteTarget ? `“${deleteTarget.name}” and its isolated run chats will be deleted. The context chat is kept.` : ""}
        confirmLabel="Delete automation"
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await action(deleteTarget.id, "DELETE");
            setDeleteTarget(null);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Could not delete automation");
          }
        }}
      />

      {currentDetail ? (
        <div id={currentDetail ? `automation-${currentDetail.id}` : undefined} className="space-y-3 pb-4">
          {detailLoading ? <p className="p-3 text-xs text-muted-foreground">Loading automation…</p> : null}
          <section className="rounded-xl border border-border/45 bg-card/45 p-3">
            <div className="flex items-start gap-2.5">
              <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-border/45 bg-background/60">
                {currentDetail.creator === "agent" ? <Bot className="size-4" /> : <UserRound className="size-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h3 className="truncate text-sm font-semibold">{currentDetail.name}</h3>
                  <span className={`text-[9px] font-medium ${statusTone(currentDetail.status)}`}>{currentDetail.status}</span>
                  <NoteProjectMenu
                    projectId={currentDetail.projectId}
                    projects={projects}
                    onChange={(nextProjectId) => {
                      void action(currentDetail.id, "PATCH", { projectId: nextProjectId }).then(() => {
                        setDetailAutomation((current) => current ? { ...current, projectId: nextProjectId || undefined } : current);
                      });
                    }}
                  />
                </div>
                <p className="mt-0.5 text-[9px] text-muted-foreground">Created by {currentDetail.creator === "agent" ? "Agent" : "You"} · max run {runLimitText(currentDetail.maxRunMinutes)}</p>
              </div>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">{currentDetail.prompt}</p>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
              <div className="rounded-lg border border-border/35 bg-background/35 p-2"><span className="block text-muted-foreground">Schedule</span><span className="mt-0.5 block truncate text-foreground">{scheduleText(currentDetail)}</span></div>
              <div className="rounded-lg border border-border/35 bg-background/35 p-2"><span className="block text-muted-foreground">Next run</span><span className="mt-0.5 block truncate text-foreground">{dateText(currentDetail.nextRunAt)}</span></div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Button type="button" size="sm" className="h-7 gap-1.5 text-[10px]" disabled={runningId === currentDetail.id || currentDetail.runs?.some((run) => run.status === "running" || run.status === "queued")} onClick={() => void runNow(currentDetail)}><Play className="size-3" />{runningId === currentDetail.id ? "Starting…" : "Run now"}</Button>
              <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 text-[10px]" onClick={() => editAutomation(currentDetail)}><Pencil className="size-3" />Edit</Button>
              {currentDetail.status === "active" ? (
                <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 text-[10px]" onClick={() => void action(currentDetail.id, "PATCH", { action: "pause" }).catch((error) => toast.error(error instanceof Error ? error.message : "Pause failed"))}><Pause className="size-3" />Pause</Button>
              ) : (
                <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 text-[10px]" onClick={() => void action(currentDetail.id, "PATCH", { action: "resume" }).catch((error) => toast.error(error instanceof Error ? error.message : "Resume failed"))}><Play className="size-3" />Resume</Button>
              )}
              <Button type="button" size="icon-sm" variant="ghost" className="ml-auto size-7" title="Delete" onClick={() => setDeleteTarget(currentDetail)}><Trash2 className="size-3.5 text-destructive" /></Button>
            </div>
          </section>

          <section className="space-y-2 rounded-xl border border-border/45 bg-card/35 p-3">
            <div className="flex items-center justify-between"><span className="flex items-center gap-1.5 text-[10px] font-semibold"><Network className="size-3.5 text-primary" />Flow</span><span className="text-[9px] text-muted-foreground">click a node</span></div>
            <AutomationGraphView automation={currentDetail} />
          </section>

          <button type="button" className="flex w-full items-center gap-2 rounded-xl border border-border/40 bg-card/35 px-3 py-2.5 text-left hover:bg-muted/45" onClick={() => onOpenChat(currentDetail.chatId)}>
            <Globe2 className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1"><span className="block text-[10px] font-medium">Context chat</span><span className="block truncate text-[9px] text-muted-foreground">{currentDetail.chatTitle || currentDetail.chatId}</span></span>
            <ChevronRight className="size-3.5 text-muted-foreground" />
          </button>

          {currentDetail.lastError ? <p className="rounded-lg border border-destructive/20 bg-destructive/10 p-2.5 text-[10px] text-destructive">{currentDetail.lastError}</p> : null}

          <section className="space-y-2">
            <div className="flex items-center justify-between px-0.5"><span className="text-[10px] font-semibold">Run history</span><span className="text-[9px] text-muted-foreground">{currentDetail.runs?.length || 0} loaded</span></div>
            {!currentDetail.runs?.length ? <p className="rounded-xl border border-dashed border-border/40 p-4 text-center text-[10px] text-muted-foreground">No runs yet. Run it now or wait for the trigger.</p> : null}
            {(currentDetail.runs || []).map((run) => (
              <button key={run.id} type="button" className="group w-full rounded-xl border border-border/40 bg-card/35 p-2.5 text-left transition hover:border-border/70 hover:bg-muted/40" onClick={() => onOpenChat(run.chatId)}>
                <div className="flex items-center gap-2">
                  <span className={`size-2 shrink-0 rounded-full ${runTone(run.status)} ${run.status === "running" ? "animate-pulse" : ""}`} />
                  <span className="min-w-0 flex-1 truncate text-[10px] font-medium">{dateText(run.startedAt || run.createdAt)}</span>
                  <span className="rounded-md border border-border/35 px-1.5 py-0.5 text-[8px] text-muted-foreground">{run.trigger || "scheduled"}</span>
                  <ChevronRight className="size-3 text-muted-foreground transition group-hover:translate-x-0.5" />
                </div>
                <div className="mt-1.5 flex items-center gap-2 pl-4 text-[9px] text-muted-foreground"><span>{run.status}</span>{durationText(run.startedAt || run.createdAt, run.completedAt) ? <><span>·</span><span>{durationText(run.startedAt || run.createdAt, run.completedAt)}</span></> : null}</div>
                {run.resultPreview ? <p className="mt-1.5 line-clamp-2 pl-4 text-[9px] leading-relaxed text-muted-foreground">{run.resultPreview}</p> : null}
                {run.error ? <p className="mt-1.5 line-clamp-2 pl-4 text-[9px] text-destructive">{run.error}</p> : null}
              </button>
            ))}
          </section>
        </div>
      ) : (
        <div className="space-y-2 pb-4">
          <div className="rounded-xl border border-border/35 bg-card/25 px-3 py-2 text-[9px] text-muted-foreground">
            Short checks and multi-day agent jobs use the same durable runtime. Every run has its own chat, tools, MCPs and persistent browser session.
          </div>
          {loading ? <p className="p-3 text-xs text-muted-foreground">Loading automations…</p> : null}
          {!loading && visibleAutomations.length === 0 ? <p className="rounded-xl border border-dashed border-border/40 p-5 text-center text-xs text-muted-foreground">{search.trim() ? "No automations match that search." : "No automations yet."}</p> : null}
          {visibleAutomations.map((automation) => {
            const activeRun = automation.runs?.find((run) => run.status === "running" || run.status === "queued");
            const latestRun = automation.runs?.[0];
            return (
              <section key={automation.id} id={`automation-${automation.id}`} className="rounded-xl border border-border/40 bg-card/40 p-3 transition hover:border-border/65">
                <button type="button" className="flex w-full items-start gap-2.5 text-left" onClick={() => { setDetailAutomation(automation); void loadDetail(automation.id); }}>
                  <div className="relative grid size-8 shrink-0 place-items-center rounded-lg border border-border/45 bg-background/55">
                    {automation.creator === "agent" ? <Bot className="size-3.5" /> : <UserRound className="size-3.5" />}
                    {activeRun ? <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-blue-400 ring-2 ring-background animate-pulse" /> : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5"><span className="truncate text-[11px] font-semibold">{automation.name}</span><span className={`shrink-0 text-[8px] ${statusTone(automation.status)}`}>{automation.status}</span></div>
                    <p className="mt-0.5 line-clamp-2 text-[9px] leading-relaxed text-muted-foreground">{automation.prompt}</p>
                  </div>
                  <ChevronRight className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
                </button>
                <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-border/25 pt-2 text-[8px] text-muted-foreground">
                    <span onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                      <NoteProjectMenu
                        projectId={automation.projectId}
                        projects={projects}
                        onChange={(nextProjectId) => {
                          void action(automation.id, "PATCH", { projectId: nextProjectId });
                        }}
                      />
                    </span>
                  <span className="inline-flex items-center gap-1"><Clock3 className="size-2.5" />{scheduleText(automation)}</span>
                  <span className="inline-flex items-center gap-1"><TimerReset className="size-2.5" />max {runLimitText(automation.maxRunMinutes)}</span>
                  <span>{automation.creator === "agent" ? "Agent" : "You"}</span>
                  {latestRun ? <span className="ml-auto inline-flex items-center gap-1"><span className={`size-1.5 rounded-full ${runTone(latestRun.status)}`} />{latestRun.status}</span> : null}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
