"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bell,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  Globe2,
  KeyRound,
  Link2,
  Lock,
  MessagesSquare,
  Mic,
  Monitor,
  MoreHorizontal,
  PlugZap,
 Puzzle,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Settings2,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Apple as AppleLogo, Microsoft as MicrosoftLogo } from "@lobehub/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ModelPicker } from "@/components/model-picker";
import { ModelOptionsMenu } from "@/components/model-options-menu";
import { ProviderLogo } from "@/components/provider-logo";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { MemoryItem } from "@/components/memories-panel";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SkillsSettings } from "@/components/skills-settings";
import { AdminUsersPanel } from "@/components/admin-users-panel";
import type { AgentMode, ToolPermissionCategory } from "@/lib/store";
import { TOOL_PERMISSION_CATEGORIES } from "@/lib/modes";
import { PlanUsagePanel } from "@/components/quota-gauges";
import type { UsageSnapshot } from "@/lib/usage-display";

type ProviderDefinition = {
  key: string;
  name: string;
  description: string;
  kind: string;
  authTypes: string[];
  defaultBaseUrl?: string;
  capabilities: Record<string, boolean>;
  models: Array<{ id: string; displayName: string; tags?: string[] }>;
  setupHint: string;
};

type ProviderConnection = {
  id: string;
  providerKey: string;
  slug: string;
  label: string;
  authType: string;
  baseUrl?: string;
  config?: Record<string, unknown>;
  enabled: boolean;
  hasSecret: boolean;
  lastCheckedAt?: string;
  lastError?: string;
};

function preferredAuthType(provider: ProviderDefinition) {
  return provider.authTypes[0] || "api_key";
}

type OAuthFlow = {
  id: string;
  connectionId: string;
  providerKey: string;
  status: "starting" | "awaiting_auth" | "awaiting_code" | "completed" | "error" | "cancelled";
  authUrl?: string;
  instructions?: string;
  userCode?: string;
  error?: string;
  manualInputRequired?: boolean;
};

type CustomSelectOption = {
  value: string;
  label: string;
  providerLogo?: string;
};

function CustomSelect({
  value,
  options,
  onValueChange,
  ariaLabel,
  disabled = false,
  className,
}: {
  value: string;
  options: CustomSelectOption[];
  onValueChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const selected = options.find((option) => option.value === value) || options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || !selected}
          aria-label={ariaLabel}
          className={cn("h-9 min-w-0 justify-between gap-2 text-left font-normal", className)}
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected?.providerLogo ? (
              <ProviderLogo providerId={selected.providerLogo} className="size-4 shrink-0" />
            ) : null}
            <span className="min-w-0 truncate">{selected?.label || "Select…"}</span>
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 min-w-[14rem] overflow-y-auto">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => onValueChange(option.value)}
            className="gap-2"
          >
            <Check className={cn("size-3.5 shrink-0", option.value === value ? "opacity-100" : "opacity-0")} />
            {option.providerLogo ? (
              <ProviderLogo providerId={option.providerLogo} className="size-4 shrink-0" />
            ) : null}
            <span className="truncate">{option.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type McpServer = {
  id: string;
  name: string;
  kind: "remote" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  enabled?: boolean;
  configured_env_keys?: string[];
  configured_header_keys?: string[];
};

type RemoteClient = {
  id: string;
  name: string;
  status: "online" | "offline" | "revoked";
  os?: string;
  version?: string;
  architecture?: string;
  hostname?: string;
  lastSeenAt?: string;
  policy: { mode: "restricted" | "approval_required" | "full_access"; allowlist: string[] };
  capabilities?: string[];
};

type ArchivedChat = {
  id: string;
  title: string;
  updatedAt: string;
  pinned?: boolean;
  archived?: boolean;
  share?: {
    id: string;
    active: boolean;
    passwordProtected: boolean;
  };
};

type McpDraft = {
  id: string;
  name: string;
  kind: "remote" | "stdio";
  url: string;
  command: string;
  args: string;
  env: string;
  headers: string;
};

const emptyMcpDraft: McpDraft = {
  id: "",
  name: "",
  kind: "remote",
  url: "",
  command: "",
  args: "",
  env: "",
  headers: "",
};

const API_KEY_URLS: Record<string, string> = {
  cursor: "https://cursor.com/dashboard/api",
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  google: "https://aistudio.google.com/app/apikey",
  antigravity: "https://aistudio.google.com/app/apikey",
  xai: "https://console.x.ai/",
  openrouter: "https://openrouter.ai/keys",
};

export type ModelParamValue = {
  value: string;
  displayName?: string;
};

export type ModelParameter = {
  id: string;
  displayName?: string;
  values: ModelParamValue[];
};

export type ModelParamSelection = {
  id: string;
  value: string;
};

export type ModelInfo = {
  id: string;
  displayName: string;
  contextWindow?: number;
  description?: string;
  providerId?: string;
  providerName?: string;
  connectionId?: string;
  connectionLabel?: string;
  source?: "cursor" | "catalog" | "discovered";
  tags?: string[];
  capabilities?: Record<string, boolean>;
  parameters?: ModelParameter[];
  defaultParams?: ModelParamSelection[];
};

export type FinishSound = {
  name: string;
  dataUrl: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settingsTab: string;
  onSettingsTabChange: (tab: string) => void;
  memories: MemoryItem[];
  notificationsEnabled: boolean;
  onNotificationsEnabledChange: (enabled: boolean) => void;
  soundCuesEnabled: boolean;
  onSoundCuesEnabledChange: (enabled: boolean) => void;
  voiceInputEnabled: boolean;
  voiceMaxDurationSeconds: number;
  voiceProvider: "openai" | "local" | "custom" | "browser";
  voiceModelId: string;
  voiceRealtime: boolean;
  voiceEndpoint: string;
  onVoiceApiKeySave: (apiKey: string) => Promise<void>;
  onVoiceInputSettingsChange: (settings: {
    enabled?: boolean;
    maxDurationSeconds?: number;
    provider?: "openai" | "local" | "custom" | "browser";
    modelId?: string;
    realtime?: boolean;
    endpoint?: string;
  }) => void;
  browserEnabled: boolean;
  browserRealtime: boolean;
  browserFps: number;
  browserViewportWidth: number;
  browserViewportHeight: number;
  onBrowserSettingsChange: (settings: {
    browserEnabled?: boolean;
    browserRealtime?: boolean;
    browserFps?: number;
    browserViewportWidth?: number;
    browserViewportHeight?: number;
  }) => void;
  compressionEnabled: boolean;
  compressionMode: "lite" | "standard" | "aggressive" | "ultra" | "rtk" | "stacked";
  compressionToolResults: boolean;
  compressionChatHistory: boolean;
  onCompressionSettingsChange: (settings: {
    enabled?: boolean;
    mode?: "lite" | "standard" | "aggressive" | "ultra" | "rtk" | "stacked";
    compressToolResults?: boolean;
    compressChatHistory?: boolean;
  }) => void;
  models: ModelInfo[];
  modelId: string;
  onModelIdChange: (modelId: string) => void;
  modelParams: ModelParamSelection[];
  onModelParamsChange: (params: ModelParamSelection[]) => void;
  favoriteModelKeys: string[];
  onToggleFavoriteModel: (modelId: string) => void;
  subagentModelEnabled: boolean;
  onSubagentModelEnabledChange: (enabled: boolean) => void;
  subagentModelId: string;
  onSubagentModelIdChange: (modelId: string) => void;
  subagentModelParams: ModelParamSelection[];
  onSubagentModelParamsChange: (params: ModelParamSelection[]) => void;
  finishSound: FinishSound | null;
  onFinishSoundChange: (sound: FinishSound | null) => void;
  onTestFinishSound: () => void;
  onMemoriesChanged: () => void;
  onMemoryDeleted: (id: string) => void;
  onChatsChanged: () => void;
  usageSnapshot: UsageSnapshot | null;
  onRefreshUsage: () => Promise<void>;
  onModelsChanged?: () => void;
  onModesChanged?: () => void;
  onLogout: () => void;
  onResetMetis?: () => Promise<void>;
  onUpdateMetis?: () => Promise<void>;
  isHostAdmin?: boolean;
};

const SETTINGS_SECTIONS: Record<string, Array<{ id: string; label: string }>> = {
  general: [
    { id: "settings-default-model", label: "Default model" },
    { id: "settings-subagent-model", label: "Subagent model" },
    { id: "settings-token-compression", label: "Token compression" },
    { id: "settings-notifications", label: "Notifications" },
    { id: "settings-voice-input", label: "Voice input" },
    { id: "settings-browser", label: "Browser" },
    { id: "settings-browser-storage", label: "Browser storage" },
    { id: "settings-session", label: "Session" },
  ],
  models: [
    { id: "settings-usage", label: "Usage" },
 { id: "settings-providers", label: "Providers" },
  ],
  agent: [
    { id: "settings-skills", label: "Skills" },
    { id: "settings-modes", label: "Agent modes" },
    { id: "settings-mcp", label: "MCP servers" },
    { id: "settings-memories", label: "Memories" },
  ],
  devices: [
    { id: "settings-remote-clients", label: "Remote clients" },
  ],
  admin: [
    { id: "settings-users", label: "Users" },
    { id: "settings-archived", label: "Archived chats" },
    { id: "settings-shared", label: "Shared chats" },
    { id: "settings-maintenance", label: "Maintenance" },
  ],
};

const SETTINGS_TABS = [
 { value: "general", label: "General" },
 { value: "models", label: "Models" },
 { value: "agent", label: "Agent" },
 { value: "devices", label: "Devices" },
 { value: "admin", label: "Admin" },
] as const;

function visibleSettingsSections(tab: string, isHostAdmin: boolean) {
 return (SETTINGS_SECTIONS[tab] || []).filter((item) => {
 if (!isHostAdmin && (item.id === "settings-users" || item.id === "settings-maintenance")) return false;
 return true;
 });
}

function scrollSettingsSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function SettingsPanel({
  open,
  onOpenChange,
  settingsTab,
  onSettingsTabChange,
  memories,
  notificationsEnabled,
  onNotificationsEnabledChange,
  soundCuesEnabled,
  onSoundCuesEnabledChange,
  voiceInputEnabled,
  voiceMaxDurationSeconds,
  voiceProvider,
  voiceModelId,
  voiceRealtime,
  voiceEndpoint,
  onVoiceApiKeySave,
  onVoiceInputSettingsChange,
  browserEnabled,
  browserRealtime,
  browserFps,
  browserViewportWidth,
  browserViewportHeight,
  onBrowserSettingsChange,
  compressionEnabled,
  compressionMode,
  compressionToolResults,
  compressionChatHistory,
  onCompressionSettingsChange,
  models,
  modelId,
  onModelIdChange,
  modelParams,
  onModelParamsChange,
  favoriteModelKeys,
  onToggleFavoriteModel,
  subagentModelEnabled,
  onSubagentModelEnabledChange,
  subagentModelId,
  onSubagentModelIdChange,
  subagentModelParams,
  onSubagentModelParamsChange,
  finishSound,
  onFinishSoundChange,
  onTestFinishSound,
  onMemoriesChanged,
  onMemoryDeleted,
  onChatsChanged,
  usageSnapshot,
  onRefreshUsage,
  onModelsChanged,
  onModesChanged,
  onLogout,
  onResetMetis,
  onUpdateMetis,
  isHostAdmin = false,
}: Props) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [deletingMemoryIds, setDeletingMemoryIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [browserStorage, setBrowserStorage] = useState<Array<{
    origin: string;
    storageTypes: string[];
    lastAccess?: string;
    sizeBytes: null;
  }>>([]);
  const [browserStorageLoading, setBrowserStorageLoading] = useState(false);
  const [browserStorageError, setBrowserStorageError] = useState("");
  const [browserStorageDeleteTarget, setBrowserStorageDeleteTarget] = useState<string | null>(null);
  const [browserStorageClearAll, setBrowserStorageClearAll] = useState(false);
  const [settingsPane, setSettingsPane] = useState<"tab" | "browser-storage">("tab");
  const [browserStorageQuery, setBrowserStorageQuery] = useState("");
  const [compressionPreview, setCompressionPreview] = useState("");
  const [compressionPreviewResult, setCompressionPreviewResult] = useState<{
    text: string;
    inputChars: number;
    outputChars: number;
    savingsPercent: number;
  } | null>(null);
  const [compressionPreviewBusy, setCompressionPreviewBusy] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpLoaded, setMcpLoaded] = useState(false);
  const [mcpDraft, setMcpDraft] = useState<McpDraft>(emptyMcpDraft);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [remoteClients, setRemoteClients] = useState<RemoteClient[]>([]);
  const [remoteCommand, setRemoteCommand] = useState("");
  const [remoteCommands, setRemoteCommands] = useState<{ linux: string; windows: string; macos: string } | null>(null);
  const [remotePlatform, setRemotePlatform] = useState<"linux" | "windows" | "macos">("linux");
  const [remotePairStep, setRemotePairStep] = useState<"idle" | "os" | "install" | "finish">("idle");
  const [remotePairExistingIds, setRemotePairExistingIds] = useState<string[]>([]);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [voiceApiKey, setVoiceApiKey] = useState("");
  const [voiceKeyBusy, setVoiceKeyBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<
    { type: "mcp"; item: McpServer } | { type: "provider"; item: ProviderConnection } | null
  >(null);
  const [providerDefinitions, setProviderDefinitions] = useState<ProviderDefinition[]>([]);
  const [providerConnections, setProviderConnections] = useState<ProviderConnection[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const providerLoadVersionRef = useRef(0);
  const [providerDraft, setProviderDraft] = useState({
    id: "",
    providerKey: "openai",
    slug: "openai-main",
    label: "OpenAI",
    authType: "api_key",
    baseUrl: "",
    secret: "",
    project: "",
    location: "",
  });
  const [providerBusy, setProviderBusy] = useState(false);
  const [customModes, setCustomModes] = useState<AgentMode[]>([]);
  const [modeDraft, setModeDraft] = useState<AgentMode>({
    id: "",
    name: "",
    description: "",
    icon: "sliders-horizontal",
    instructions: "",
    allowedCategories: ["read"],
  });
  const [modeOverridesDraft, setModeOverridesDraft] = useState("{}");
  const [oauthFlow, setOauthFlow] = useState<OAuthFlow | null>(null);
  const [oauthCode, setOauthCode] = useState("");
  const [archivedChats, setArchivedChats] = useState<ArchivedChat[]>([]);
  const [sharedChats, setSharedChats] = useState<ArchivedChat[]>([]);
  const [archivedChatsLoaded, setArchivedChatsLoaded] = useState(false);
  const [browserNotificationsAvailable, setBrowserNotificationsAvailable] =
    useState(false);
  const [resetMetisOpen, setResetMetisOpen] = useState(false);
  const [updateMetisOpen, setUpdateMetisOpen] = useState(false);
  const loadRemoteClients = useCallback(async () => {
    try {
      const response = await fetch("/api/remote-clients", { cache: "no-store" });
      if (!response.ok) throw new Error("Failed to load remote clients");
      const data = (await response.json()) as { clients?: RemoteClient[] };
      setRemoteClients(data.clients || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load remote clients");
    }
  }, []);

  const loadBrowserStorage = useCallback(async () => {
    setBrowserStorageLoading(true);
    setBrowserStorageError("");
    try {
      const response = await fetch("/api/browser/storage", { cache: "no-store" });
      const data = (await response.json()) as { origins?: typeof browserStorage; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not load browser storage");
      setBrowserStorage(data.origins || []);
    } catch (error) {
      setBrowserStorageError(error instanceof Error ? error.message : "Could not load browser storage");
    } finally {
      setBrowserStorageLoading(false);
    }
  }, []);

  const clearBrowserStorage = useCallback(async (origin?: string) => {
    const response = await fetch("/api/browser/storage", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(origin ? { origin } : { all: true }),
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(data.error || "Could not clear browser storage");
    toast.success(origin ? `Browser data cleared for ${origin}` : "All browser data cleared");
    await loadBrowserStorage();
  }, [loadBrowserStorage]);

  useEffect(() => {
   if (!open) {
    setSettingsPane("tab");
    setBrowserStorageQuery("");
    return;
   }
   if (settingsTab === "general" || settingsPane === "browser-storage") {
    void loadBrowserStorage();
   }
  }, [loadBrowserStorage, open, settingsPane, settingsTab]);

  const createRemoteEnrollment = useCallback(async (platform = remotePlatform) => {
    setRemoteBusy(true);
    setRemotePlatform(platform);
    setRemotePairExistingIds(remoteClients.map((client) => client.id));
    try {
      const response = await fetch("/api/remote-clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ os: platform }),
      });
      const data = (await response.json()) as { command?: string; commands?: { linux?: string; windows?: string; macos?: string }; error?: string };
      if (!response.ok || !data.command) throw new Error(data.error || "Failed to create enrollment command");
      setRemoteCommand(data.command);
      setRemoteCommands({
        linux: data.commands?.linux || data.command,
        windows: data.commands?.windows || "",
        macos: data.commands?.macos || "",
      });
      setRemotePairStep("install");
      await navigator.clipboard?.writeText(data.command);
      toast.success("Enrollment command copied");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create enrollment command");
    } finally {
      setRemoteBusy(false);
    }
  }, [remoteClients, remotePlatform]);

  const copyRemoteCommand = useCallback(async () => {
    const command = remoteCommands?.[remotePlatform] || remoteCommand;
    try {
      await navigator.clipboard.writeText(command);
      toast.success("Install command copied");
    } catch {
      toast.error("Could not copy install command");
    }
  }, [remoteCommand, remoteCommands, remotePlatform]);

  const testRemoteConnection = useCallback(async (client: RemoteClient) => {
    const response = await fetch(`/api/remote-clients/${encodeURIComponent(client.id)}/test`, { method: "POST" });
    const data = (await response.json()) as { info?: { hostname?: string; os?: string; uptime?: number }; error?: string };
    if (!response.ok) {
      toast.error(data.error || "Connection test failed");
      return;
    }
    toast.success(`${data.info?.hostname || client.name} is connected`);
    await loadRemoteClients();
  }, [loadRemoteClients]);

  const updateRemotePolicy = useCallback(async (client: RemoteClient, mode: RemoteClient["policy"]["mode"]) => {
    const response = await fetch(`/api/remote-clients/${encodeURIComponent(client.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: { ...client.policy, mode } }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || "Failed to update policy");
    }
    await loadRemoteClients();
  }, [loadRemoteClients]);

  const renameRemoteClient = useCallback(async (client: RemoteClient, name: string) => {
    const nextName = name.trim();
    if (!nextName || nextName === client.name) return;
    const response = await fetch(`/api/remote-clients/${encodeURIComponent(client.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nextName }),
    });
    if (!response.ok) toast.error("Failed to rename remote client");
    else await loadRemoteClients();
  }, [loadRemoteClients]);

  const revokeRemoteClient = useCallback(async (client: RemoteClient) => {
    if (!window.confirm(`Remove ${client.name} from this dashboard? The local client must still be uninstalled separately.`)) return;
    const response = await fetch(`/api/remote-clients/${encodeURIComponent(client.id)}`, { method: "DELETE" });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      toast.error(data.error || "Failed to revoke client");
      return;
    }
    toast.success("Remote client removed");
    await loadRemoteClients();
  }, [loadRemoteClients]);

  useEffect(() => {
    if (!open || settingsTab !== "devices") return;
    void loadRemoteClients();
    const timer = window.setInterval(() => void loadRemoteClients(), 2_000);
    return () => window.clearInterval(timer);
  }, [loadRemoteClients, open, settingsTab]);
  useEffect(() => {
    if (remotePairStep !== "install") return;
    let active = true;
    const checkForConnection = async () => {
      try {
        const response = await fetch("/api/remote-clients", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { clients?: RemoteClient[] };
        if (!active) return;
        const clients = data.clients || [];
        setRemoteClients(clients);
        const knownIds = new Set(remotePairExistingIds);
        const connectedClient = clients.find((client) => !knownIds.has(client.id) && client.status === "online");
        if (connectedClient) {
          setRemotePairStep("finish");
          toast.success(`${connectedClient.name} connected`);
        }
      } catch {
        // The normal settings refresh will retry while the modal is open.
      }
    };
    void checkForConnection();
    const timer = window.setInterval(() => void checkForConnection(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [remotePairExistingIds, remotePairStep]);
  useEffect(() => {
    setBrowserNotificationsAvailable(
      typeof window !== "undefined" && "Notification" in window,
    );
  }, []);

  const loadMcpServers = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp-servers", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load MCP servers");
      const data = (await res.json()) as { servers?: McpServer[] };
      setMcpServers(data.servers || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load MCP servers");
    } finally {
      setMcpLoaded(true);
    }
  }, []);

  const loadArchivedChats = useCallback(async () => {
    setArchivedChatsLoaded(false);
    try {
      const res = await fetch("/api/chats?includeArchived=true", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load archived chats");
      const data = (await res.json()) as { chats?: ArchivedChat[] };
      const chats = data.chats || [];
      setArchivedChats(chats.filter((chat) => chat.archived));
      setSharedChats(chats.filter((chat) => chat.share?.active));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load archived chats");
    } finally {
      setArchivedChatsLoaded(true);
    }
  }, []);

  const loadProviders = useCallback(async () => {
    const loadVersion = ++providerLoadVersionRef.current;
    setProvidersLoaded(false);
    try {
      const res = await fetch("/api/providers", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load providers");
      const data = (await res.json()) as {
        providers?: ProviderDefinition[];
        connections?: ProviderConnection[];
      };
      if (loadVersion !== providerLoadVersionRef.current) return;
      setProviderDefinitions(data.providers || []);
      setProviderConnections(data.connections || []);
      const first = data.providers?.[0];
      if (first) {
        setProviderDraft((current) => {
          if (current.id || data.providers?.some((provider) => provider.key === current.providerKey)) {
            return current;
          }
          return {
            ...current,
            providerKey: first.key,
            authType: preferredAuthType(first),
            baseUrl: first.defaultBaseUrl || "",
          };
        });
      }
    } catch (error) {
      if (loadVersion === providerLoadVersionRef.current) {
        toast.error(error instanceof Error ? error.message : "Failed to load providers");
      }
    } finally {
      if (loadVersion === providerLoadVersionRef.current) setProvidersLoaded(true);
    }
  }, []);

  const loadCustomModes = useCallback(async () => {
    const response = await fetch("/api/modes", { cache: "no-store" });
    if (!response.ok) return;
    const data = (await response.json()) as { modes?: AgentMode[] };
    setCustomModes((data.modes || []).filter((mode) => !mode.builtIn));
  }, []);

  useEffect(() => {
    if (open) {
      void loadMcpServers();
      void loadArchivedChats();
      void loadProviders();
      void loadCustomModes();
    }
  }, [loadArchivedChats, loadCustomModes, loadMcpServers, loadProviders, open]);

  async function updateArchivedChat(id: string, archived: boolean) {
    const res = await fetch(`/api/chats/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    });
    if (!res.ok) {
      toast.error("Failed to update chat");
      return;
    }
    await loadArchivedChats();
    onChatsChanged();
    toast.success(archived ? "Chat archived" : "Chat restored");
  }

  async function saveCustomMode() {
    const payload = {
      ...modeDraft,
      id: modeDraft.id || undefined,
      allowedCategories: modeDraft.allowedCategories,
      toolOverrides: (() => {
        try {
          const parsed = JSON.parse(modeOverridesDraft);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        } catch {
          return {};
        }
      })(),
    };
    const response = await fetch("/api/modes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      toast.error("Could not save mode");
      return;
    }
    setModeDraft({ id: "", name: "", description: "", icon: "sliders-horizontal", instructions: "", allowedCategories: ["read"] });
    setModeOverridesDraft("{}");
    await loadCustomModes();
    onModesChanged?.();
    toast.success("Mode saved");
  }

  async function deleteCustomMode(mode: AgentMode) {
    await fetch(`/api/modes?id=${encodeURIComponent(mode.id)}`, { method: "DELETE" });
    await loadCustomModes();
    onModesChanged?.();
  }

  async function deleteArchivedChat(id: string) {
    const res = await fetch(`/api/chats/${id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Failed to delete chat");
      return;
    }
    await loadArchivedChats();
    onChatsChanged();
    toast.success("Chat deleted");
  }

  async function deactivateShare(chat: ArchivedChat) {
    const res = await fetch(`/api/chats/${chat.id}/share`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Failed to deactivate share");
      return;
    }
    await loadArchivedChats();
    onChatsChanged();
    toast.success("Share link deactivated");
  }

  async function addMemory() {
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          (err as { error?: string }).error || "Failed to add memory",
        );
      }
      setDraft("");
      onMemoriesChanged();
      toast.success("Memory saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add memory");
    } finally {
      setBusy(false);
    }
  }

  async function removeMemory(id: string) {
    if (deletingMemoryIds.has(id)) return;
    setDeletingMemoryIds((current) => new Set(current).add(id));
    try {
      const res = await fetch(`/api/memories/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      onMemoryDeleted(id);
      toast.success("Memory deleted");
    } catch {
      toast.error("Failed to delete memory");
    } finally {
      setDeletingMemoryIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  function parseLines(value: string) {
    const entries: Record<string, string> = {};
    for (const line of value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      const separator = line.indexOf("=");
      if (separator <= 0) throw new Error("Environment and header lines must use NAME=value");
      const key = line.slice(0, separator).trim();
      const item = line.slice(separator + 1);
      if (!/^[A-Za-z_][A-Za-z0-9-]*$/.test(key)) throw new Error(`Invalid key: ${key}`);
      entries[key] = item;
    }
    return entries;
  }

  async function saveMcpServer() {
    if (mcpBusy) return;
    setMcpBusy(true);
    try {
      if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(mcpDraft.id)) {
        throw new Error("ID must use 2-64 lowercase characters, numbers, dots, underscores, or hyphens");
      }
      if (!mcpDraft.name.trim()) throw new Error("Name is required");
      if (mcpDraft.kind === "remote" && !mcpDraft.url.trim()) throw new Error("URL is required");
      if (mcpDraft.kind === "stdio" && !mcpDraft.command.trim()) throw new Error("Command is required");
      const env = parseLines(mcpDraft.env);
      const headers = parseLines(mcpDraft.headers);
      const body = {
        id: mcpDraft.id.trim(),
        name: mcpDraft.name.trim(),
        kind: mcpDraft.kind,
        ...(mcpDraft.url.trim() ? { url: mcpDraft.url.trim() } : {}),
        ...(mcpDraft.command.trim() ? { command: mcpDraft.command.trim() } : {}),
        ...(mcpDraft.args.trim() ? { args: mcpDraft.args.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
      };
      const res = await fetch("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Failed to save MCP server");
      setMcpDraft(emptyMcpDraft);
      await loadMcpServers();
      toast.success("MCP server saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save MCP server");
    } finally {
      setMcpBusy(false);
    }
  }

  function editMcpServer(server: McpServer) {
    setMcpDraft({
      id: server.id,
      name: server.name,
      kind: server.kind,
      url: server.url || "",
      command: server.command || "",
      args: server.args?.join("\n") || "",
      env: "",
      headers: "",
    });
  }

  async function toggleMcpServer(server: McpServer) {
    const res = await fetch(`/api/mcp-servers/${encodeURIComponent(server.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !server.enabled }),
    });
    if (!res.ok) {
      toast.error("Failed to update MCP server");
      return;
    }
    await loadMcpServers();
  }

  async function deleteMcpServer(server: McpServer) {
    const res = await fetch(`/api/mcp-servers/${encodeURIComponent(server.id)}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Failed to delete MCP server");
      return;
    }
    await loadMcpServers();
    if (mcpDraft.id === server.id) setMcpDraft(emptyMcpDraft);
    toast.success("MCP server deleted");
  }

  function selectProvider(providerKey: string) {
    const definition = providerDefinitions.find((provider) => provider.key === providerKey);
    setProviderDraft((current) => ({
      ...current,
      providerKey,
      authType: definition ? preferredAuthType(definition) : "api_key",
      baseUrl: definition?.defaultBaseUrl || "",
      slug: current.id ? current.slug : `${providerKey}-main`,
      label: current.id ? current.label : definition?.name || providerKey,
      secret: "",
      project: "",
      location: "",
    }));
  }

  function editProviderConnection(connection: ProviderConnection) {
    const definition = providerDefinitions.find((provider) => provider.key === connection.providerKey);
    setProviderDraft({
      id: connection.id,
      providerKey: connection.providerKey,
      slug: connection.slug,
      label: connection.label,
      authType: connection.authType,
      baseUrl: connection.baseUrl || "",
      secret: "",
      project: typeof connection.config?.project === "string" ? connection.config.project : "",
      location: typeof connection.config?.location === "string" ? connection.config.location : "",
    });
    onSettingsTabChange("models");
    requestAnimationFrame(() => {
      document.getElementById("provider-connection-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  async function saveProviderConnection() {
    if (providerBusy) return;
    setProviderBusy(true);
    try {
      const editableConfig =
        providerDraft.authType === "vertex_adc" ||
        (providerDraft.providerKey === "antigravity" && providerDraft.authType === "oauth")
          ? {
              ...(providerDraft.project.trim() ? { project: providerDraft.project.trim() } : {}),
              ...(providerDraft.authType === "vertex_adc" && providerDraft.location.trim()
                ? { location: providerDraft.location.trim() }
                : {}),
            }
          : undefined;
      const body: Record<string, unknown> = providerDraft.id
        ? {
            label: providerDraft.label.trim(),
            ...(providerDraft.authType !== "oauth" ? { baseUrl: providerDraft.baseUrl.trim() } : {}),
            ...(providerDraft.secret ? { secret: providerDraft.secret } : {}),
            ...(editableConfig ? { config: editableConfig } : {}),
          }
        : {
            providerKey: providerDraft.providerKey,
            slug: providerDraft.slug.trim(),
            label: providerDraft.label.trim(),
            authType: providerDraft.authType,
            ...(providerDraft.baseUrl.trim() ? { baseUrl: providerDraft.baseUrl.trim() } : {}),
            ...(providerDraft.secret ? { secret: providerDraft.secret } : {}),
            ...(editableConfig ? { config: editableConfig } : {}),
          };
      const res = await fetch(
        providerDraft.id ? `/api/providers/${encodeURIComponent(providerDraft.id)}` : "/api/providers",
        {
          method: providerDraft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        connection?: ProviderConnection;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || "Failed to save provider connection");
      await loadProviders();
      onModelsChanged?.();
      const definition = providerDefinitions.find((provider) => provider.key === providerDraft.providerKey);
      setProviderDraft((current) => ({
        id: "",
        providerKey: current.providerKey,
        slug: `${current.providerKey}-main`,
        label: definition?.name || current.providerKey,
        authType: current.authType,
        baseUrl: current.authType === "vertex_adc" ? "" : definition?.defaultBaseUrl || "",
        secret: "",
        project: "",
        location: "",
      }));
      toast.success("Provider connection saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save provider connection");
    } finally {
      setProviderBusy(false);
    }
  }

  async function connectProviderOAuth() {
    if (providerBusy) return;
    setProviderBusy(true);
    setOauthFlow(null);
    setOauthCode("");
    let openedAuthUrl = false;
    try {
      const res = await fetch("/api/providers/oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerKey: providerDraft.providerKey,
          slug: providerDraft.slug.trim(),
          label: providerDraft.label.trim(),
          ...(providerDraft.providerKey === "antigravity" && providerDraft.project.trim()
            ? { config: { project: providerDraft.project.trim() } }
            : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        flow?: OAuthFlow;
        error?: string;
      };
      if (!res.ok || !data.flow) throw new Error(data.error || "Failed to start OAuth login");
      setOauthFlow(data.flow);

      for (let attempt = 0; attempt < 600; attempt += 1) {
        const statusRes = await fetch(
          `/api/providers/oauth/status?flowId=${encodeURIComponent(data.flow.id)}`,
          { cache: "no-store" },
        );
        const statusData = (await statusRes.json().catch(() => ({}))) as {
          flow?: OAuthFlow;
          error?: string;
        };
        if (!statusRes.ok || !statusData.flow) {
          throw new Error(statusData.error || "Failed to read OAuth status");
        }
        const nextFlow = statusData.flow;
        setOauthFlow(nextFlow);
        if (nextFlow.authUrl && !openedAuthUrl) {
          openedAuthUrl = true;
          const popup = window.open(nextFlow.authUrl, "_blank", "noopener,noreferrer");
          if (!popup) toast.info("Open the OAuth link shown below to continue.");
        }
        if (["completed", "error", "cancelled"].includes(nextFlow.status)) {
          if (nextFlow.status === "completed") {
            await loadProviders();
            onModelsChanged?.();
            setProviderDraft((current) => ({
              ...current,
              id: "",
              slug: `${current.providerKey}-main`,
              secret: "",
              project: "",
              location: "",
            }));
            toast.success("OAuth connection completed");
          } else if (nextFlow.error) {
            toast.error(nextFlow.error);
          }
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
      throw new Error("OAuth login timed out.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "OAuth login failed");
    } finally {
      setProviderBusy(false);
    }
  }

  async function submitOAuthCode() {
    if (!oauthFlow || !oauthCode.trim()) return;
    const res = await fetch("/api/providers/oauth/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flowId: oauthFlow.id, code: oauthCode.trim() }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      toast.error(data.error || "Failed to submit OAuth code");
      return;
    }
    setOauthCode("");
    toast.success("OAuth code submitted");
  }

  async function toggleProviderConnection(connection: ProviderConnection) {
    const res = await fetch(`/api/providers/${encodeURIComponent(connection.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !connection.enabled }),
    });
    if (!res.ok) {
      toast.error("Failed to update provider connection");
      return;
    }
    await loadProviders();
    onModelsChanged?.();
  }

  async function testProviderConnection(connection: ProviderConnection) {
    const res = await fetch(`/api/providers/${encodeURIComponent(connection.id)}/test`, { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
    if (!res.ok) {
      toast.error(data.error || "Provider connection failed");
      await loadProviders();
      onModelsChanged?.();
      return;
    }
    toast.success(data.detail || "Provider connection is ready");
    await loadProviders();
    onModelsChanged?.();
  }

  async function discoverProviderModels(connection: ProviderConnection) {
    const res = await fetch(`/api/providers/${encodeURIComponent(connection.id)}/discover`, { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { models?: unknown[]; error?: string };
    if (!res.ok) {
      toast.error(data.error || "Model discovery failed");
      return;
    }
    toast.success(`${data.models?.length || 0} models discovered`);
    await loadProviders();
    onModelsChanged?.();
  }

  async function deleteProviderConnection(connection: ProviderConnection) {
    const res = await fetch(`/api/providers/${encodeURIComponent(connection.id)}`, { method: "DELETE" });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      toast.error(data.error || "Failed to delete provider connection");
      return;
    }

    // Remove it from the visible settings state immediately. A slower, older
    // providers request must not be able to resurrect a connection that was
    // already deleted.
    providerLoadVersionRef.current += 1;
    setProviderConnections((current) => current.filter((item) => item.id !== connection.id));
    if (providerDraft.id === connection.id) {
      const definition = providerDefinitions.find((provider) => provider.key === connection.providerKey);
      setProviderDraft((current) => ({
        ...current,
        id: "",
        slug: `${connection.providerKey}-main`,
        label: definition?.name || connection.providerKey,
        authType: definition ? preferredAuthType(definition) : current.authType,
        baseUrl: definition?.defaultBaseUrl || "",
        secret: "",
        project: "",
        location: "",
      }));
    }
    onModelsChanged?.();
    void onRefreshUsage();
    await loadProviders();
    toast.success("Provider connection deleted");
  }

  async function toggleNotifications() {
    if (notificationsEnabled) {
      onNotificationsEnabledChange(false);
      return;
    }
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "default") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast.warning(
          permission === "denied"
            ? "Browser notifications are blocked."
            : "Browser notification permission was not granted.",
        );
        return;
      }
    } else if (Notification.permission !== "granted") {
      toast.warning("Browser notifications are blocked.");
      return;
    }
    onNotificationsEnabledChange(true);
  }

  function handleFinishSoundUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("audio/")) {
      toast.error("Please choose an audio file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Custom sounds must be 5 MB or smaller.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      onFinishSoundChange({ name: file.name, dataUrl: reader.result });
      toast.success("Custom finish sound saved");
    };
    reader.onerror = () => toast.error("Could not read the audio file.");
    reader.readAsDataURL(file);
  }

  const filteredBrowserStorage = browserStorage.filter((item) => {
   const query = browserStorageQuery.trim().toLowerCase();
   if (!query) return true;
   return item.origin.toLowerCase().includes(query) || item.storageTypes.some((type) => type.toLowerCase().includes(query));
  });

  const selectableProviders = providerDefinitions;
  const sortedProviderConnections = [...providerConnections].sort((a, b) => {
    const aName = providerDefinitions.find((provider) => provider.key === a.providerKey)?.name || a.providerKey;
    const bName = providerDefinitions.find((provider) => provider.key === b.providerKey)?.name || b.providerKey;
    return `${aName} ${a.label}`.localeCompare(`${bName} ${b.label}`);
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(58rem,calc(100dvh-1rem))] min-w-[min(42rem,calc(100vw-1rem))] w-[calc(100%-1rem)] max-w-6xl flex-col gap-0 overflow-hidden rounded-2xl p-0">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-5 pr-14 sm:px-8">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Settings2 className="size-4 text-primary" />
            Settings
          </DialogTitle>
          <DialogDescription className="text-xs sm:text-sm">
            Manage your workspace in one place.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={settingsTab} onValueChange={(tab) => { setSettingsPane("tab"); setBrowserStorageQuery(""); onSettingsTabChange(tab); }} className="min-h-0 flex-1 gap-0 md:grid md:items-stretch md:grid-cols-[13rem_minmax(0,1fr)]">
          <div className="border-b border-border bg-muted/20 p-3 md:hidden">
            <CustomSelect
              value={settingsTab}
              onValueChange={(tab) => { setSettingsPane("tab"); setBrowserStorageQuery(""); onSettingsTabChange(tab); }}
              ariaLabel="Settings section"
              className="h-10 w-full"
              options={[
                { value: "general", label: "General" },
                { value: "models", label: "Models" },
                { value: "agent", label: "Agent" },
 { value: "devices", label: "Devices" },
 { value: "admin", label: isHostAdmin ? "Admin" : "Chats" },
              ]}
            />
          </div>
          <TabsList className="hidden h-auto w-full shrink-0 flex-wrap justify-start gap-1.5 rounded-none border-b border-border bg-muted/20 px-4 py-3 md:flex md:h-full md:min-h-0 md:flex-nowrap md:flex-col md:items-start md:justify-start md:overflow-y-auto md:border-b-0 md:border-r md:px-3 md:py-5">
           {SETTINGS_TABS.map((tab) => {
           const Icon =
           tab.value === "general" ? Settings2
           : tab.value === "models" ? KeyRound
           : tab.value === "agent" ? Puzzle
           : tab.value === "devices" ? PlugZap
           : Users;
           const label = tab.value === "admin" ? (isHostAdmin ? "Admin" : "Chats") : tab.label;
           const expanded = settingsTab === tab.value;
           return (
           <Fragment key={tab.value}>
           <TabsTrigger value={tab.value} className="min-h-10 justify-start px-3.5 py-2.5 md:h-auto md:w-full md:flex-none">
           <Icon data-icon="inline-start" />
           {label}
           </TabsTrigger>
           {expanded
           ? visibleSettingsSections(tab.value, isHostAdmin).map((item) => (
           <button
            key={item.id}
            type="button"
            className={cn(
            "ml-4 hidden w-[calc(100%-1rem)] truncate rounded-md border-l border-border/40 px-2.5 py-1 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground md:block",
            item.id === "settings-browser-storage" && settingsPane === "browser-storage" && "bg-muted/60 text-foreground",
            )}
            onClick={() => {
            if (item.id === "settings-browser-storage") {
            setSettingsPane("browser-storage");
            return;
            }
            setSettingsPane("tab");
            scrollSettingsSection(item.id);
            }}
            >
           {item.label}
           </button>
           ))
           : null}
           </Fragment>
           );
           })}
          </TabsList>

          <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto">
 {settingsPane === "browser-storage" ? (
 <div
 className="flex h-full min-h-0 flex-col gap-5 px-6 py-6 sm:px-8 sm:py-8"
 data-slot="browser-storage-manager"
 >
 <button
 type="button"
 className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
 onClick={() => setSettingsPane("tab")}
 >
 <ArrowLeft className="size-3.5" />
 Back to General
 </button>
 <div className="flex items-start justify-between gap-3">
 <div>
 <h3 className="text-sm font-medium">Browser storage</h3>
 <p className="mt-1 text-xs text-muted-foreground">
 Persistent website sessions are stored privately for your account. Search the list and clear individual origins without scrolling General.
 </p>
 </div>
 <Button type="button" variant="destructive" size="sm" onClick={() => setBrowserStorageClearAll(true)} disabled={!browserStorage.length}>
 Clear all
 </Button>
 </div>
 <Input
 value={browserStorageQuery}
 onChange={(event) => setBrowserStorageQuery(event.target.value)}
 placeholder="Search websites"
 aria-label="Search stored websites"
 />
 {browserStorageLoading ? <p className="text-xs text-muted-foreground">Loading stored websites…</p> : null}
 {browserStorageError ? <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">{browserStorageError}</p> : null}
 {!browserStorageLoading && !browserStorageError && !browserStorage.length ? (
 <p className="rounded-md border border-border/60 p-4 text-xs text-muted-foreground">No persistent website data stored yet.</p>
 ) : null}
 {!browserStorageLoading && !browserStorageError && browserStorage.length > 0 && filteredBrowserStorage.length === 0 ? (
 <p className="rounded-md border border-border/60 p-4 text-xs text-muted-foreground">No websites match that search.</p>
 ) : null}
 <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
 {filteredBrowserStorage.map((item) => (
 <div key={item.origin} className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-3">
 <div className="min-w-0">
 <p className="truncate text-sm">{item.origin}</p>
 <p className="mt-1 text-[11px] text-muted-foreground">
 {item.storageTypes.join(" · ")}
 {item.sizeBytes === null ? " · size unavailable" : ` · ${item.sizeBytes} bytes`}
 </p>
 </div>
 <Button type="button" variant="outline" size="sm" onClick={() => setBrowserStorageDeleteTarget(item.origin)}>
 Clear
 </Button>
 </div>
 ))}
 </div>
 </div>
 ) : (
 <>
<TabsContent value="general" className="mt-0 space-y-10 px-6 py-6 sm:px-8 sm:py-8">

 <section className="flex flex-col gap-4">
                <h3 id="settings-default-model" className="text-sm font-medium">Default model</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Choose the model used for new chats. Each user has an independent default.
                  </p>
                  <div className="mt-3 flex min-w-0 items-center gap-1">
                    <ModelPicker
                      models={models}
                      value={modelId}
                      onValueChange={onModelIdChange}
                      favoriteModelKeys={favoriteModelKeys}
                      onToggleFavorite={onToggleFavoriteModel}
                      className="min-w-0 flex-1"
                    />
                    {models.find((model) => model.id === modelId) ? (
                      <ModelOptionsMenu
                        model={models.find((model) => model.id === modelId)!}
                        modelParams={modelParams}
                        onModelParamsChange={onModelParamsChange}
                        className="opacity-100"
                      />
                    ) : null}
                  </div>
 </section>

 <section className="flex flex-col gap-4">
                  <h3 id="settings-subagent-model" className="text-sm font-medium">Subagent model</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Optionally use one model for delegated subagents. When disabled, the agent chooses the model.
                  </p>
                  <div className="mt-3 flex items-center justify-between gap-4">
                    <p className="text-xs text-muted-foreground">Use a standard model</p>
                    <Button
                      type="button"
                      variant={subagentModelEnabled ? "default" : "outline"}
                      aria-pressed={subagentModelEnabled}
                      onClick={() => onSubagentModelEnabledChange(!subagentModelEnabled)}
                      className="shrink-0"
                    >
                      {subagentModelEnabled ? "On" : "Off"}
                    </Button>
                  </div>
                  <div className="mt-3 flex min-w-0 items-center gap-1">
                    <ModelPicker
                      models={models}
                      value={subagentModelId}
                      onValueChange={onSubagentModelIdChange}
                      favoriteModelKeys={favoriteModelKeys}
                      onToggleFavorite={onToggleFavoriteModel}
                      disabled={!subagentModelEnabled}
                      className="min-w-0 flex-1"
                    />
                    {models.find((model) => model.id === subagentModelId) ? (
                      <ModelOptionsMenu
                        model={models.find((model) => model.id === subagentModelId)!}
                        modelParams={subagentModelParams}
                        onModelParamsChange={onSubagentModelParamsChange}
                        className="opacity-100"
                      />
                    ) : null}
                  </div>
 </section>

              <section className="flex flex-col gap-5">
                <div>
                  <h3 id="settings-token-compression" className="text-sm font-medium">Token compression</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Reduce noisy tool output and redundant context before it reaches the model.
                  </p>
                </div>
                <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 p-4">
                  <div>
                    <p className="text-sm font-medium">Enable compression</p>
                    <p className="mt-1 text-xs text-muted-foreground">Disabled by default and isolated per user.</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={compressionEnabled ? "default" : "outline"}
                    aria-pressed={compressionEnabled}
                    onClick={() => onCompressionSettingsChange({ enabled: !compressionEnabled })}
                  >
                    {compressionEnabled ? "On" : "Off"}
                  </Button>
                </div>
                <label className="flex flex-col gap-2 text-xs font-medium">
                  Mode
                  <select
                    value={compressionMode}
                    disabled={!compressionEnabled}
                    onChange={(event) => onCompressionSettingsChange({ mode: event.target.value as typeof compressionMode })}
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm font-normal"
                  >
                    <option value="lite">Lite — low risk cleanup</option>
                    <option value="standard">Standard — prose condensation</option>
                    <option value="aggressive">Aggressive — stronger compression</option>
                    <option value="rtk">RTK — terminal and tool output</option>
                    <option value="stacked">Stacked — RTK + Caveman (recommended)</option>
                    <option value="ultra">Ultra — maximum context recovery</option>
                  </select>
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Button type="button" variant={compressionToolResults ? "secondary" : "outline"} disabled={!compressionEnabled} onClick={() => onCompressionSettingsChange({ compressToolResults: !compressionToolResults })}>
                    Tool results: {compressionToolResults ? "On" : "Off"}
                  </Button>
                  <Button type="button" variant={compressionChatHistory ? "secondary" : "outline"} disabled={!compressionEnabled} onClick={() => onCompressionSettingsChange({ compressChatHistory: !compressionChatHistory })}>
                    Chat history: {compressionChatHistory ? "On" : "Off"}
                  </Button>
                </div>
                <div className="space-y-3 rounded-lg border border-border/60 p-4">
                  <div>
                    <p className="text-sm font-medium">Preview</p>
                    <p className="mt-1 text-xs text-muted-foreground">The sample is sent only for this preview and is never stored.</p>
                  </div>
                  <Textarea value={compressionPreview} onChange={(event) => setCompressionPreview(event.target.value)} placeholder="Paste a terminal log or verbose context sample…" rows={6} />
                  <Button
                    type="button"
                    size="sm"
                    disabled={!compressionPreview.trim() || compressionPreviewBusy}
                    onClick={async () => {
                      setCompressionPreviewBusy(true);
                      try {
                        const response = await fetch("/api/compression/preview", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ text: compressionPreview, mode: compressionMode }),
                        });
                        const data = await response.json() as typeof compressionPreviewResult & { error?: string };
                        if (!response.ok) throw new Error(data.error || "Preview failed");
                        setCompressionPreviewResult(data);
                      } catch (error) {
                        toast.error(error instanceof Error ? error.message : "Preview failed");
                      } finally {
                        setCompressionPreviewBusy(false);
                      }
                    }}
                  >
                    {compressionPreviewBusy ? "Analyzing…" : "Analyze preview"}
                  </Button>
                  {compressionPreviewResult ? (
                    <div className="rounded-md bg-muted/40 p-3 text-xs">
                      <p>{compressionPreviewResult.inputChars} → {compressionPreviewResult.outputChars} characters ({compressionPreviewResult.savingsPercent}% reduced)</p>
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-muted-foreground">{compressionPreviewResult.text}</pre>
                    </div>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  Aggressive and ultra modes can remove wording. Code blocks, URLs, paths and structured data are protected where possible.
                </p>
              </section>

              <section className="flex flex-col gap-4">
                <div>
                  <h3 id="settings-notifications" className="text-sm font-medium">Notifications</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Get notified when the agent needs input or finishes a
                    response.
                  </p>
                </div>
                {browserNotificationsAvailable ? (
                  <>
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-xs text-muted-foreground">
                        Browser notifications
                      </p>
                      <Button
                        type="button"
                        variant={notificationsEnabled ? "default" : "outline"}
                        aria-pressed={notificationsEnabled}
                        onClick={() => void toggleNotifications()}
                        className="shrink-0"
                      >
                        {notificationsEnabled ? "On" : "Off"}
                      </Button>
                    </div>
                    {Notification.permission === "denied" ? (
                      <p className="text-xs text-amber-400">
                        Notifications are blocked in this browser.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Browser notifications are unavailable.
                  </p>
                )}
                <div className="flex items-center justify-between gap-4 border-t border-border/60 pt-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Sound cues</p>
                    <p className="mt-1 text-xs text-muted-foreground/70">
                      Play a sound when an agent finishes.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant={soundCuesEnabled ? "default" : "outline"}
                    aria-pressed={soundCuesEnabled}
                    onClick={() => onSoundCuesEnabledChange(!soundCuesEnabled)}
                    className="shrink-0"
                  >
                    {soundCuesEnabled ? "On" : "Off"}
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="file"
                    accept="audio/*"
                    onChange={handleFinishSoundUpload}
                    aria-label="Upload custom finish sound"
                    className="min-w-0 flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onTestFinishSound}
                    disabled={!soundCuesEnabled}
                  >
                    Test sound
                  </Button>
                  {finishSound ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => onFinishSoundChange(null)}
                    >
                      Remove custom sound
                    </Button>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {finishSound
                    ? `Custom sound: ${finishSound.name}`
                    : "No custom sound uploaded. The default completion sound plays when sound cues are on. Removing a custom file restores that default."}
                </p>
 </section>

              <section className="flex flex-col gap-4">
                <div>
                  <h3 id="settings-voice-input" className="text-sm font-medium">Voice input</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Choose how speech is transcribed before it is inserted into the composer.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    Provider
                    <select
                      value={voiceProvider}
                      onChange={(event) => onVoiceInputSettingsChange({
                        provider: event.target.value as "openai" | "local" | "custom" | "browser",
                        ...(event.target.value === "browser" ? { realtime: true } : {}),
                      })}
                      className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                    >
                      <option value="openai">OpenAI</option>
                      <option value="local">Local</option>
                      <option value="browser">Browser transcription</option>
                      <option value="custom">Custom endpoint</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    Model ID
                    <Input
                      value={voiceModelId}
                      onChange={(event) => onVoiceInputSettingsChange({ modelId: event.target.value })}
                      placeholder={voiceProvider === "openai" ? "whisper-1" : "model id"}
                    />
                  </label>
                </div>
                {voiceProvider === "openai" ? (
                  <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
                    <p className="font-medium text-foreground">OpenAI presets</p>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="xs" variant={!voiceRealtime ? "secondary" : "outline"} onClick={() => onVoiceInputSettingsChange({ modelId: "whisper-1", realtime: false })}>
                        whisper-1
                      </Button>
                      <Button type="button" size="xs" variant={voiceRealtime ? "secondary" : "outline"} onClick={() => onVoiceInputSettingsChange({ modelId: "gpt-realtime-whisper", realtime: true })}>
                        GPT Realtime Whisper
                      </Button>
                    </div>
                  </div>
                ) : null}
                {voiceProvider === "custom" || voiceProvider === "local" ? (
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    Transcription endpoint
                    <Input value={voiceEndpoint} onChange={(event) => onVoiceInputSettingsChange({ endpoint: event.target.value })} placeholder="http://127.0.0.1:9000/v1" />
                  </label>
                ) : null}
                {voiceProvider === "openai" || voiceProvider === "custom" ? (
                  <div className="grid gap-2 rounded-lg border border-border/60 p-3">
                    <label className="grid gap-1 text-xs text-muted-foreground">
                      API key
                      <Input
                        type="password"
                        value={voiceApiKey}
                        onChange={(event) => setVoiceApiKey(event.target.value)}
                        placeholder="Stored encrypted on the server"
                        autoComplete="new-password"
                      />
                    </label>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">The key is never returned to the browser.</span>
                      <Button
                        type="button"
                        size="xs"
                        disabled={voiceKeyBusy || !voiceApiKey.trim()}
                        onClick={() => {
                          setVoiceKeyBusy(true);
                          void onVoiceApiKeySave(voiceApiKey).then(() => {
                            setVoiceApiKey("");
                            toast.success("Voice API key saved");
                          }).catch((error) => {
                            toast.error(error instanceof Error ? error.message : "Could not save voice API key.");
                          }).finally(() => setVoiceKeyBusy(false));
                        }}
                      >
                        {voiceKeyBusy ? "Saving…" : "Save key"}
                      </Button>
                    </div>
                  </div>
                ) : null}
                {voiceProvider === "custom" ? (
                  <label className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-3 text-xs">
                    <span>
                      <span className="block font-medium text-foreground">Streaming transcription</span>
                      <span className="text-muted-foreground">Show partial speech above the composer.</span>
                    </span>
                    <Button type="button" size="sm" variant={voiceRealtime ? "default" : "outline"} aria-pressed={voiceRealtime} onClick={() => onVoiceInputSettingsChange({ realtime: !voiceRealtime })}>
                      {voiceRealtime ? "On" : "Off"}
                    </Button>
                  </label>
                ) : null}
                <div className="flex items-center justify-between gap-4 border-t border-border/60 pt-4">
                  <div>
                    <p className="text-xs font-medium">Microphone button</p>
                    <p className="text-xs text-muted-foreground">Enable voice input in the composer.</p>
                  </div>
                  <Button type="button" size="sm" variant={voiceInputEnabled ? "default" : "outline"} aria-pressed={voiceInputEnabled} onClick={() => onVoiceInputSettingsChange({ enabled: !voiceInputEnabled })}>
                    {voiceInputEnabled ? "On" : "Off"}
                  </Button>
                </div>
                <label className="grid max-w-xs gap-1 text-xs text-muted-foreground">
                  Maximum recording length (seconds)
                  <Input type="number" min={1} max={3600} value={voiceMaxDurationSeconds} disabled={!voiceInputEnabled} onChange={(event) => onVoiceInputSettingsChange({ maxDurationSeconds: Math.max(1, Math.min(3600, Number(event.target.value) || 300)) })} />
                </label>
              </section>

 <section className="flex flex-col gap-4">
 <div>
 <h3 id="settings-browser" className="text-sm font-medium">Browser</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Browser settings live in the browser tab. Open a chat, switch to Browser, then use the gear next to reload.
                </p>
 </div>
 </section>

 <section className="flex flex-col gap-4">
 <div className="flex items-start justify-between gap-3">
 <div>
 <h3 id="settings-browser-storage" className="text-sm font-medium">Browser storage</h3>
 <p className="mt-1 text-xs text-muted-foreground">
 Persistent website sessions for the embedded browser. Search and clear origins in a dedicated view so General stays short.
 </p>
 </div>
 <Button type="button" variant="outline" size="sm" onClick={() => setSettingsPane("browser-storage")}>
 Manage
 </Button>
 </div>
 <p className="text-xs text-muted-foreground">
 {browserStorageLoading
 ? "Loading stored websites…"
 : browserStorage.length
 ? `${browserStorage.length} website${browserStorage.length === 1 ? "" : "s"} stored`
 : "No persistent website data stored yet."}
 </p>
 </section>

              <section className="flex flex-col gap-3">
                <div>
                  <h3 id="settings-session" className="text-sm font-medium">Session</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Lock this chat and return to the sign-in screen.
                  </p>
                </div>
                <Button
                  variant="outline"
                  className="w-full justify-start gap-2"
                  onClick={() => {
                    onOpenChange(false);
                    onLogout();
                  }}
                >
                  <Lock className="size-4" />
                  Lock screen
                </Button>
                
              </section>

 </TabsContent>
<TabsContent value="models" className="mt-0 space-y-10 px-6 py-6 sm:px-8 sm:py-8 min-w-0">

              <div id="settings-usage"><PlanUsagePanel snapshot={usageSnapshot} onRefresh={onRefreshUsage} /></div>

              <section className="flex flex-col gap-4">
                <div>
                  <h3 id="settings-providers" className="text-sm font-medium">AI providers and connections</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Credentials are stored encrypted on the server and are never returned to the browser.
                    Configure API keys, OAuth, SDK, CLI, and local connections together in one list.
                  </p>
                </div>
                <div id="provider-connection-form" className={`space-y-3 rounded-xl border p-4 ${providerDraft.id ? "border-primary/40 bg-primary/5" : "border-border/60 bg-muted/20"}`}>
                  {providerDraft.id ? (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-medium text-primary">
                        Editing existing connection · {providerDraft.id.slice(0, 8)}…
                      </p>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => setProviderDraft((current) => ({
                          ...current,
                          id: "",
                          slug: `${current.providerKey}-main`,
                          label: providerDefinitions.find((provider) => provider.key === current.providerKey)?.name || current.label,
                          secret: "",
                        }))}
                      >
                        New connection instead
                      </Button>
                    </div>
                  ) : null}
                  <div className="grid gap-2 sm:grid-cols-2">
                  <CustomSelect
                    value={providerDraft.providerKey}
                    onValueChange={selectProvider}
                    ariaLabel="Provider"
                    disabled={Boolean(providerDraft.id)}
                    className="w-full"
                    options={selectableProviders.map((provider) => ({
                      value: provider.key,
                      label: provider.name,
                      providerLogo: provider.key,
                    }))}
                  />
                  <CustomSelect
                    value={providerDraft.authType}
                    onValueChange={(authType) => setProviderDraft((current) => ({ ...current, authType }))}
                    ariaLabel="Authentication method"
                    disabled={Boolean(providerDraft.id)}
                    className="w-full"
                    options={(providerDefinitions.find((provider) => provider.key === providerDraft.providerKey)?.authTypes || ["api_key"]).map((authType) => ({
                      value: authType,
                      label: authType === "api_key"
                        ? (providerDraft.providerKey === "antigravity" ? "Gemini API key (SDK)" : "API key")
                        : authType === "oauth"
                          ? (providerDraft.providerKey === "antigravity" ? "OAuth (agy CLI)" : "OAuth")
                          : authType === "vertex_adc"
                            ? "Google Vertex / ADC"
                            : authType === "account"
                              ? "Official account credentials"
                              : authType === "local" ? "CLI on this machine" : "Local endpoint",
                    }))}
                  />
                  <Input
                    value={providerDraft.slug}
                    onChange={(event) => setProviderDraft((current) => ({ ...current, slug: event.target.value }))}
                    placeholder="connection-id"
                    aria-label="Connection ID"
                    disabled={Boolean(providerDraft.id)}
                  />
                  <Input
                    value={providerDraft.label}
                    onChange={(event) => setProviderDraft((current) => ({ ...current, label: event.target.value }))}
                    placeholder="Connection name"
                    aria-label="Connection name"
                  />
                </div>
                {providerDraft.authType === "vertex_adc" ||
                (providerDraft.providerKey === "antigravity" && providerDraft.authType === "oauth") ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input
                      value={providerDraft.project}
                      onChange={(event) => setProviderDraft((current) => ({ ...current, project: event.target.value }))}
                      placeholder={providerDraft.authType === "oauth" ? "Optional GCP project (workspace accounts need this)" : "GCP project"}
                      aria-label="GCP project"
                    />
                    <Input
                      value={providerDraft.location}
                      onChange={(event) => setProviderDraft((current) => ({ ...current, location: event.target.value }))}
                      placeholder="us-central1"
                      aria-label="GCP location"
                    />
                  </div>
                ) : providerDraft.providerKey !== "cursor" &&
        providerDraft.providerKey !== "grok-build" &&
        providerDraft.providerKey !== "opencode" &&
        providerDraft.authType !== "oauth" &&
        providerDraft.authType !== "local" ? (
                  <Input
                    value={providerDraft.baseUrl}
                    onChange={(event) => setProviderDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                    placeholder="https://api.example.com/v1"
                    aria-label="Provider base URL"
                  />
                ) : null}
                {providerDraft.authType !== "local" &&
                providerDraft.authType !== "vertex_adc" &&
                providerDraft.authType !== "oauth" ? (
                  <Input
                    type="password"
                    value={providerDraft.secret}
                    onChange={(event) => setProviderDraft((current) => ({ ...current, secret: event.target.value }))}
                    placeholder={providerDraft.authType === "account" ? "Paste official auth.json content" : "Secret is write-only"}
                    aria-label="Provider credential"
                    autoComplete="new-password"
                  />
                ) : null}
                {providerDraft.authType === "api_key" && API_KEY_URLS[providerDraft.providerKey] ? (
                  <a
                    href={API_KEY_URLS[providerDraft.providerKey]}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary underline underline-offset-2"
                  >
                    Get {providerDefinitions.find((provider) => provider.key === providerDraft.providerKey)?.name || "provider"} API key
                  </a>
                ) : null}
                {providerDefinitions.find((provider) => provider.key === providerDraft.providerKey)?.setupHint ? (
                  <p className="text-xs text-muted-foreground">
                    {providerDefinitions.find((provider) => provider.key === providerDraft.providerKey)?.setupHint}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                {providerDraft.authType === "oauth" ? (
                  <>
                    {providerDraft.id ? (
                      <Button type="button" onClick={() => void saveProviderConnection()} disabled={providerBusy || !providersLoaded || !providerDraft.label.trim()}>
                        {providerBusy ? "Saving…" : "Save changes"}
                      </Button>
                    ) : null}
                    <Button type="button" variant={providerDraft.id ? "outline" : "default"} onClick={() => void connectProviderOAuth()} disabled={providerBusy || !providersLoaded}>
                      {providerBusy ? "Connecting…" : providerDraft.id ? "Reconnect OAuth" : "Connect via OAuth"}
                    </Button>
                  </>
                ) : (
                    <Button type="button" onClick={() => void saveProviderConnection()} disabled={providerBusy || !providersLoaded || !providerDraft.label.trim()}>
                      {providerBusy ? "Saving…" : providerDraft.id ? "Update connection" : "Save connection"}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setProviderDraft((current) => ({
                      ...current,
                      id: "",
                      slug: `${current.providerKey}-main`,
                      label: providerDefinitions.find((provider) => provider.key === current.providerKey)?.name || current.label,
                      secret: "",
                    }))}
                  >
                    Clear
                  </Button>
                </div>
                </div>
                {oauthFlow ? (
                  <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3">
                    <div>
                      <p className="text-sm font-medium">
                        OAuth: {oauthFlow.status}
                      </p>
                      {oauthFlow.instructions ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {oauthFlow.instructions}
                        </p>
                      ) : null}
                    </div>
                    {oauthFlow.authUrl ? (
                      <a
                        href={oauthFlow.authUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="block break-all text-xs text-primary underline underline-offset-2"
                      >
                        Open OAuth authorization link
                      </a>
                    ) : null}
                    {oauthFlow.userCode ? (
                      <div className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2">
                        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Device code
                        </p>
                        <p className="mt-1 select-all font-mono text-xl font-semibold tracking-[0.18em] text-foreground">
                          {oauthFlow.userCode}
                        </p>
                      </div>
                    ) : null}
                    {oauthFlow.manualInputRequired ? (
                      <div className="flex gap-2">
                        <Input
                          value={oauthCode}
                          onChange={(event) => setOauthCode(event.target.value)}
                          placeholder="Code or complete callback URL"
                          aria-label="OAuth code or callback URL"
                        />
                        <Button type="button" onClick={() => void submitOAuthCode()} disabled={!oauthCode.trim()}>
                          Submit
                        </Button>
                      </div>
                    ) : null}
                    {oauthFlow.providerKey === "claude-code" ? (
                      <p className="text-xs text-amber-400">
                        Claude OAuth is an experimental personal-use flow and may conflict with Anthropic's current third-party usage restrictions.
                      </p>
                    ) : null}
                    {oauthFlow.providerKey === "antigravity" ? (
                      <p className="text-xs text-amber-400">
                        Antigravity OAuth uses the official agy CLI remote-login flow and stores its token profile per connection.
                      </p>
                    ) : null}
                    {oauthFlow.error ? (
                      <p className="text-xs text-red-400">{oauthFlow.error}</p>
                    ) : null}
                  </div>
                ) : null}
                {!providersLoaded ? (
                  <div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
                    Loading provider connections…
                  </div>
                ) : providerConnections.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
                    No provider connections configured yet.
                  </div>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {sortedProviderConnections.map((connection) => {
                      const definition = providerDefinitions.find((provider) => provider.key === connection.providerKey);
                      return (
                        <li key={connection.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-card/40 p-3">
                          <ProviderLogo providerId={connection.providerKey} className="size-5" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">
                              {connection.label}
                              <span className="ml-2 text-xs font-normal text-muted-foreground">{definition?.name || connection.providerKey}</span>
                            </p>
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                              {connection.slug} · {connection.authType} · {connection.enabled ? "enabled" : "disabled"}
                              {connection.hasSecret ? " · credential set" : ""}
                            </p>
                            {connection.lastError ? <p className="mt-1 text-xs text-red-400">{connection.lastError}</p> : null}
                          </div>
                          <Button type="button" size="sm" variant={connection.enabled ? "outline" : "default"} onClick={() => void toggleProviderConnection(connection)}>
                            {connection.enabled ? "Disable" : "Enable"}
                          </Button>
                          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Test ${connection.label}`} onClick={() => void testProviderConnection(connection)}><PlugZap className="size-3.5" /></Button>
                          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Refresh models for ${connection.label}`} onClick={() => void discoverProviderModels(connection)}><RefreshCw className="size-3.5" /></Button>
                          <Button type="button" size="sm" variant="ghost" onClick={() => editProviderConnection(connection)}>Edit</Button>
                          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Delete ${connection.label}`} onClick={() => setDeleteTarget({ type: "provider", item: connection })}><Trash2 className="size-3.5" /></Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
 </TabsContent>
<TabsContent value="agent" className="mt-0 space-y-10 px-6 py-6 sm:px-8 sm:py-8">

              <div className="mb-8">
 <div id="settings-skills"><SkillsSettings /></div>
 </div>
 <section className="flex flex-col gap-4">
                <div>
                  <h3 id="settings-modes" className="text-sm font-medium">Agent modes</h3>
                  <p className="mt-1 text-xs text-muted-foreground">Create reusable modes with custom instructions and server-enforced tool permissions.</p>
                </div>
                <div className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-4">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input value={modeDraft.name} onChange={(event) => setModeDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Mode name" aria-label="Mode name" />
                    <Input value={modeDraft.icon} onChange={(event) => setModeDraft((current) => ({ ...current, icon: event.target.value }))} placeholder="Icon name" aria-label="Mode icon" />
                  </div>
                  <Input value={modeDraft.description} onChange={(event) => setModeDraft((current) => ({ ...current, description: event.target.value }))} placeholder="Short description" aria-label="Mode description" />
                  <Textarea value={modeDraft.instructions} onChange={(event) => setModeDraft((current) => ({ ...current, instructions: event.target.value }))} placeholder="Custom instructions for this mode" aria-label="Mode instructions" />
                  <div className="flex flex-wrap gap-1.5">
                    {TOOL_PERMISSION_CATEGORIES.map((category) => {
                      const active = modeDraft.allowedCategories.includes(category);
                      return <Button key={category} type="button" size="xs" variant={active ? "default" : "outline"} onClick={() => setModeDraft((current) => ({ ...current, allowedCategories: active ? current.allowedCategories.filter((item) => item !== category) : [...current.allowedCategories, category as ToolPermissionCategory] }))}>{category}</Button>;
                    })}
                  </div>
                  <Textarea value={modeOverridesDraft} onChange={(event) => setModeOverridesDraft(event.target.value)} placeholder='{"write_file": false}' aria-label="Individual tool overrides" className="min-h-16 font-mono text-xs" />
                  <p className="text-[11px] text-muted-foreground">Optional individual overrides as JSON, for example {"{"}"write_file": false{"}"}</p>
                  <div className="flex justify-end">
                    <Button type="button" onClick={() => void saveCustomMode()} disabled={!modeDraft.name.trim()}>Save mode</Button>
                  </div>
                </div>
                {customModes.length ? (
                  <div className="divide-y rounded-xl border">
                    {customModes.map((mode) => (
                      <div key={mode.id} className="flex items-center gap-3 px-3 py-2.5">
                        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{mode.name}</p><p className="truncate text-xs text-muted-foreground">{mode.description || "Custom mode"}</p></div>
                        <Button type="button" size="xs" variant="ghost" onClick={() => { setModeDraft(mode); setModeOverridesDraft(JSON.stringify(mode.toolOverrides || {}, null, 2)); }}>Edit</Button>
                        <Button type="button" size="xs" variant="ghost" className="text-destructive" onClick={() => void deleteCustomMode(mode)}>Delete</Button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>

              <section className="flex flex-col gap-4">
                <div>
                  <h3 id="settings-mcp" className="text-sm font-medium">Custom MCP servers</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Add remote HTTP or local stdio MCP servers. Secret values are write-only.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    value={mcpDraft.id}
                    onChange={(e) => setMcpDraft((current) => ({ ...current, id: e.target.value }))}
                    placeholder="server-id"
                    aria-label="MCP server ID"
                  />
                  <Input
                    value={mcpDraft.name}
                    onChange={(e) => setMcpDraft((current) => ({ ...current, name: e.target.value }))}
                    placeholder="Display name"
                    aria-label="MCP server name"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant={mcpDraft.kind === "remote" ? "default" : "outline"}
                    onClick={() => setMcpDraft((current) => ({ ...current, kind: "remote" }))}
                  >
                    Remote HTTP
                  </Button>
                  <Button
                    type="button"
                    variant={mcpDraft.kind === "stdio" ? "default" : "outline"}
                    onClick={() => setMcpDraft((current) => ({ ...current, kind: "stdio" }))}
                  >
                    Local stdio
                  </Button>
                </div>
                {mcpDraft.kind === "remote" ? (
                  <Input
                    value={mcpDraft.url}
                    onChange={(e) => setMcpDraft((current) => ({ ...current, url: e.target.value }))}
                    placeholder="https://example.com/mcp"
                    aria-label="MCP server URL"
                  />
                ) : (
                  <>
                    <Input
                      value={mcpDraft.command}
                      onChange={(e) => setMcpDraft((current) => ({ ...current, command: e.target.value }))}
                      placeholder="npx"
                      aria-label="MCP command"
                    />
                    <Textarea
                      value={mcpDraft.args}
                      onChange={(e) => setMcpDraft((current) => ({ ...current, args: e.target.value }))}
                      placeholder={"One argument per line\n-y\n@modelcontextprotocol/server-filesystem\n/path/to/allowed-directory"}
                      aria-label="MCP arguments"
                      rows={4}
                    />
                  </>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <Textarea
                    value={mcpDraft.env}
                    onChange={(e) => setMcpDraft((current) => ({ ...current, env: e.target.value }))}
                    placeholder={"Environment (NAME=value)\nAPI_KEY=..."}
                    aria-label="MCP environment"
                    rows={4}
                  />
                  <Textarea
                    value={mcpDraft.headers}
                    onChange={(e) => setMcpDraft((current) => ({ ...current, headers: e.target.value }))}
                    placeholder={"Headers (NAME=value)\nAuthorization=Bearer ..."}
                    aria-label="MCP headers"
                    rows={4}
                  />
                </div>
                <div className="flex gap-2">
                  <Button type="button" onClick={() => void saveMcpServer()} disabled={mcpBusy}>
                    {mcpBusy ? "Saving…" : "Save server"}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setMcpDraft(emptyMcpDraft)}>
                    Clear
                  </Button>
                </div>
                <ul className="flex flex-col gap-2">
                  {!mcpLoaded ? (
                    [0, 1, 2].map((item) => (
                      <li key={item} className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-3" aria-label="Loading MCP servers" role="status">
                        <Skeleton className="h-4 w-2/5" />
                        <Skeleton className="h-3 w-3/5" />
                      </li>
                    ))
                  ) : mcpServers.map((server) => (
                    <li key={server.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-card/40 p-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{server.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {server.id} · {server.kind} · {server.enabled ? "enabled" : "disabled"}
                        </p>
                        {(server.configured_env_keys?.length || server.configured_header_keys?.length) ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Secrets configured: {[...(server.configured_env_keys || []), ...(server.configured_header_keys || [])].join(", ")}
                          </p>
                        ) : null}
                      </div>
                      <Button type="button" size="sm" variant="outline" onClick={() => void toggleMcpServer(server)}>
                        {server.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => editMcpServer(server)}>
                        Edit
                      </Button>
                      <Button type="button" size="icon-sm" variant="ghost" onClick={() => setDeleteTarget({ type: "mcp", item: server })} aria-label={`Delete ${server.name}`}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="flex flex-col gap-3">
                <div>
                  <h3 id="settings-memories" className="text-sm font-medium">Memories</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Durable facts injected into every turn. The agent can
                    write these itself.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Add a memory…"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void addMemory();
                      }
                    }}
                  />
                  <Button
                    size="icon"
                    onClick={() => void addMemory()}
                    disabled={busy || !draft.trim()}
                    aria-label="Add memory"
                  >
                    <Plus className="size-4" />
                  </Button>
                </div>
                <ul className="flex flex-col gap-2">
                  {memories.length === 0 ? (
                    <li className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
                      No memories yet.
                    </li>
                  ) : (
                    memories.map((m) => (
                      <li
                        key={m.id}
                        className="group flex items-start gap-2 rounded-lg border border-border/60 bg-card/40 p-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm whitespace-pre-wrap">
                            {m.content}
                          </p>
                          {m.tags && m.tags.length > 0 ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {m.tags.join(" · ")}
                            </p>
                          ) : null}
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="opacity-100 sm:opacity-60 sm:group-hover:opacity-100"
                          onClick={() => void removeMemory(m.id)}
                          disabled={deletingMemoryIds.has(m.id)}
                          aria-label="Delete memory"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </li>
                    ))
                  )}
                </ul>
              </section>
 </TabsContent>
<TabsContent value="devices" className="mt-0 space-y-10 px-6 py-6 sm:px-8 sm:py-8">

              <section className="flex flex-col gap-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 id="settings-remote-clients" className="text-sm font-medium">Remote Clients</h3>
                    <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
                      Clients use an outbound encrypted connection. New clients start with full access.
                    </p>
                  </div>
                  <Button type="button" size="sm" onClick={() => setRemotePairStep("os")} disabled={remoteBusy}>
                    <Plus data-icon="inline-start" />
                    Add client
                  </Button>
                </div>
                <div className="flex flex-col gap-2">
                  {remoteClients.length ? remoteClients.map((client) => (
                    <div key={client.id} className="rounded-lg border bg-card/40 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-2">
                          {client.os?.toLowerCase().includes("win") ? <MicrosoftLogo className="mt-1 size-4 shrink-0 text-muted-foreground" /> : client.os?.toLowerCase().includes("mac") ? <AppleLogo className="mt-1 size-4 shrink-0 text-muted-foreground" /> : <Server className="mt-1 size-4 shrink-0 text-muted-foreground" />}
                          <div className="min-w-0">
                          <Input
                           key={`${client.id}:${client.name}`}
                            defaultValue={client.name}
                            aria-label={`Custom name for ${client.name}`}
                            className="h-7 max-w-[16rem] border-transparent px-0 text-sm font-medium shadow-none focus-visible:border-input focus-visible:px-2"
                            onBlur={(event) => void renameRemoteClient(client, event.target.value)}
                          />
                          <p className="text-xs text-muted-foreground">
                            {client.hostname || "Unknown host"} · {client.os || "Unknown OS"} · {client.architecture || "unknown arch"}
                          </p>
                          <div className="mt-1.5">
                            <Badge
                              variant={client.policy.mode === "full_access" ? "default" : "outline"}
                              className={client.policy.mode === "full_access"
                                ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                                : ""}
                            >
                              {client.policy.mode === "full_access"
                                ? "Full access enabled"
                                : "Restricted"}
                            </Badge>
                          </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className={`size-2 rounded-full ${client.status === "online" ? "bg-emerald-500" : "bg-muted-foreground/40"}`} title={client.status} />
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild><Button type="button" size="icon-xs" variant="ghost" aria-label={`Manage ${client.name}`}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => void testRemoteConnection(client)}>Test connection</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void updateRemotePolicy(client, client.policy.mode === "full_access" ? "restricted" : "full_access")}>
                                {client.policy.mode === "full_access" ? "Switch to restricted" : "Enable full access"}
                              </DropdownMenuItem>
                              <DropdownMenuItem className="text-destructive" onClick={() => void revokeRemoteClient(client)}>Remove client</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                        <span>{client.status}</span>
                        {client.version ? <span>v{client.version}</span> : null}
                        {client.lastSeenAt ? <span>seen {new Date(client.lastSeenAt).toLocaleString()}</span> : null}
                      </div>
                    </div>
                  )) : (
                    <p className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">No remote clients enrolled yet.</p>
                  )}
                </div>
              </section>
 </TabsContent>
<TabsContent value="admin" className="mt-0 space-y-10 px-6 py-6 sm:px-8 sm:py-8">
{isHostAdmin ? (
                <div id="settings-users"><AdminUsersPanel /></div>) : null}

              <section className="flex flex-col gap-4">
                <div>
                  <h3 id="settings-archived" className="flex items-center gap-2 text-sm font-medium">
                    <Archive className="size-4 text-muted-foreground" />
                    Archived chats
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Archived chats disappear from the sidebar but remain available in chat search.
                  </p>
                </div>
                {!archivedChatsLoaded ? (
                  <div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
                    Loading archived chats…
                  </div>
                ) : archivedChats.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
                    No archived chats.
                  </div>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {archivedChats.map((chat) => (
                      <li
                        key={chat.id}
                        className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/40 p-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{chat.title || "Untitled"}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            Archived chat
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void updateArchivedChat(chat.id, false)}
                        >
                          <ArchiveRestore className="size-3.5" />
                          Restore
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Delete ${chat.title || "archived chat"}`}
                          onClick={() => void deleteArchivedChat(chat.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="border-t border-border/60 pt-5">
                  <div>
                    <h3 id="settings-shared" className="flex items-center gap-2 text-sm font-medium">
                      <Link2 className="size-4 text-muted-foreground" />
                      Shared chats
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Manage active read-only links for your chats.
                    </p>
                  </div>
                  {sharedChats.length === 0 ? (
                    <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                      No active shared chats.
                    </div>
                  ) : (
                    <ul className="mt-3 flex flex-col gap-2">
                      {sharedChats.map((chat) => (
                        <li key={chat.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-card/40 p-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{chat.title || "Untitled"}</p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {chat.share?.passwordProtected ? "Password protected" : "Public link"}
                            </p>
                          </div>
                          {chat.share ? (
                            <a
                              href={`/share?id=${encodeURIComponent(chat.share.id)}`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input px-2.5 text-xs font-medium hover:bg-accent"
                            >
                              <Link2 className="size-3.5" />
                              Open link
                            </a>
                          ) : null}
                          <Button type="button" size="sm" variant="outline" onClick={() => void deactivateShare(chat)}>
                            Deactivate
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>

{isHostAdmin ? (
                  <div className="mt-3 border-t border-destructive/30 pt-4">
                    <h3 id="settings-maintenance" className="text-sm font-medium">Metis maintenance</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Prepare a production update or reset Metis to its clean initial state.
                    </p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <Button type="button" variant="outline" onClick={() => setUpdateMetisOpen(true)}>
                        <RefreshCw data-icon="inline-start" />
                        Update Metis
                      </Button>
                      <Button type="button" variant="destructive" onClick={() => setResetMetisOpen(true)}>
                        <RotateCcw data-icon="inline-start" />
                        Reset account
                      </Button>
                    </div>
                  </div>
                ) : null}
 </TabsContent>
 </>
 )}
          </div>
        </Tabs>
      </DialogContent>
      </Dialog>
      <Dialog open={remotePairStep !== "idle"} onOpenChange={(value) => !value && setRemotePairStep("idle")}>
        <DialogContent className="box-border w-[calc(100vw_-_2rem)] max-w-[calc(100vw_-_2rem)] gap-0 overflow-x-hidden overflow-y-auto rounded-2xl p-0 sm:w-[min(56rem,calc(100vw_-_2rem))] sm:max-w-[min(56rem,calc(100vw_-_2rem))]">
          <div className="min-w-0 w-full max-w-full space-y-5 p-6">
          <DialogHeader>
            <DialogTitle>Connect a remote client</DialogTitle>
            <DialogDescription>
              Pair a device with this account and keep it available for terminal sessions.
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground" aria-label="Remote client setup progress">
            {["Choose OS", "Install", "Connected"].map((label, index) => {
              const activeIndex = remotePairStep === "os" ? 0 : remotePairStep === "install" ? 1 : 2;
              const complete = index < activeIndex;
              return (
                <div key={label} className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium", index <= activeIndex ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                    {complete ? <Check className="size-3" /> : index + 1}
                  </span>
                  <span className={cn("truncate", index <= activeIndex && "text-foreground")}>{label}</span>
                  {index < 2 ? <span className="mx-1 h-px flex-1 bg-border" /> : null}
                </div>
              );
            })}
          </div>
          {remotePairStep === "os" ? (
            <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-3">
              {([
                ["linux", "Linux", Server],
                ["windows", "Windows", MicrosoftLogo],
                ["macos", "macOS", AppleLogo],
              ] as const).map(([value, label, Icon]) => (
                <Button key={value} type="button" variant="outline" className="h-24 flex-col gap-2 rounded-xl" onClick={() => void createRemoteEnrollment(value)} disabled={remoteBusy}>
                  <Icon className="size-8" />
                  <span>{label}</span>
                </Button>
              ))}
            </div>
          ) : remotePairStep === "install" ? (
            <div className="min-w-0 space-y-4 rounded-xl border border-border/60 bg-muted/20 p-4">
              <div>
                <p className="flex items-center gap-2 text-sm font-medium"><Monitor className="size-4 text-primary" /> Install the client</p>
                <p className="mt-1 text-xs text-muted-foreground">Run this command on the device you want to connect.</p>
              </div>
              <div className="w-full min-w-0 max-w-full overflow-hidden">
                <Textarea readOnly value={remoteCommands?.[remotePlatform] || remoteCommand} className="block min-h-32 w-full min-w-0 max-w-full resize-y overflow-auto [field-sizing:fixed] bg-background font-mono text-xs" />
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => void copyRemoteCommand()}>Copy install command</Button>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
                <RefreshCw className="size-3.5 animate-spin" />
                Waiting for installation…
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-6 text-center">
              <div className="relative flex size-16 items-center justify-center">
                <span className="absolute inset-0 rounded-full border border-emerald-500/20 animate-in fade-in zoom-in-75 duration-500" />
                <span className="relative flex size-12 items-center justify-center rounded-full border-2 border-emerald-500 text-emerald-500 animate-in zoom-in-50 duration-500">
                  <Check className="size-6 animate-in zoom-in-50 delay-150 duration-500" strokeWidth={3} />
                </span>
              </div>
              <div><p className="text-sm font-medium">Connected</p><p className="mt-1 text-xs text-muted-foreground">The remote client is ready to use. You can close this window.</p></div>
              <Button type="button" onClick={() => setRemotePairStep("idle")}>Done</Button>
            </div>
          )}
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
      open={Boolean(deleteTarget)}
      onOpenChange={(open) => !open && setDeleteTarget(null)}
      title={deleteTarget?.type === "mcp" ? "Delete MCP server?" : "Delete provider connection?"}
      description={
        deleteTarget?.type === "mcp"
          ? `Are you sure you want to delete “${deleteTarget.item.name}”? This action cannot be undone.`
          : `Are you sure you want to delete “${deleteTarget?.item.label || "this connection"}”? This action cannot be undone.`
      }
      confirmLabel="Delete"
      onConfirm={() => {
        if (!deleteTarget) return;
        return deleteTarget.type === "mcp"
          ? deleteMcpServer(deleteTarget.item)
          : deleteProviderConnection(deleteTarget.item);
      }}
      />
      <ConfirmDialog
        open={Boolean(browserStorageDeleteTarget)}
        onOpenChange={(open) => !open && setBrowserStorageDeleteTarget(null)}
        title="Clear website data?"
        description={browserStorageDeleteTarget ? `All persistent browser data for “${browserStorageDeleteTarget}” will be removed.` : ""}
        confirmLabel="Clear data"
        onConfirm={async () => {
          if (!browserStorageDeleteTarget) return;
          await clearBrowserStorage(browserStorageDeleteTarget);
          setBrowserStorageDeleteTarget(null);
        }}
      />
      <ConfirmDialog
        open={browserStorageClearAll}
        onOpenChange={setBrowserStorageClearAll}
        title="Clear all browser data?"
        description="This logs you out of every website in the embedded browser and cannot be undone."
        confirmLabel="Clear everything"
        onConfirm={async () => {
          await clearBrowserStorage();
          setBrowserStorageClearAll(false);
        }}
      />
      <ConfirmDialog
        open={updateMetisOpen}
        onOpenChange={setUpdateMetisOpen}
        title="Update Metis?"
        description="Metis will install the locked dependencies and build the inactive production slot. The active service will not be restarted automatically."
        confirmLabel="Prepare update"
        destructive={false}
        onConfirm={async () => {
          if (onUpdateMetis) await onUpdateMetis();
        }}
      />
      <ConfirmDialog
        open={resetMetisOpen}
        onOpenChange={setResetMetisOpen}
        title="Reset all Metis data?"
        description="This permanently removes chats, notes, memories, provider credentials, MCP servers, workflows, browser data, automations, remote clients, jobs and usage history. User accounts and the base installation remain. You will be signed out and must set up Metis again."
        confirmLabel="Reset everything"
        onConfirm={async () => {
          if (onResetMetis) await onResetMetis();
        }}
      />
    </>
  );
}
