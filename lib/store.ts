import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";

export type ToolPart = {
  id: string;
  name: string;
  status: "running" | "completed" | "error" | string;
  detail?: string;
  kind?: "plan" | "edit" | "read" | "shell" | "subagent" | "mcp" | "canvas" | "note" | "todo" | "browser" | "memory" | "automation" | "compaction" | "other";
  source?: "mcp" | "native" | "browser";
  path?: string;
  input?: string;
  result?: string;
  todos?: Array<{ id?: string; content: string; status?: string }>;
  subagent?: {
    agentId?: string;
    chatId?: string;
    title?: string;
    mode?: string;
    model?: string;
    prompt?: string;
    thinking?: string;
    messages?: Array<{ role: string; text: string; timestamp?: string }>;
    tools?: ToolPart[];
  };
  diff?: {
    before?: string;
    after?: string;
    additions?: number;
    deletions?: number;
  };
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  errorMessage?: string;
  referenceText?: string;
  thinking?: string;
  tools?: ToolPart[];
  parts?: MessagePart[];
  suggestions?: Array<string | { label: string; prompt: string }>;
  references?: Array<{
    kind: string;
    id: string;
    label: string;
    source?: "explicit" | "pinned";
    detail?: string;
    path?: string;
    content?: string;
  }>;
  attachments?: Array<{
    id: string;
    name: string;
    mimeType: string;
    kind: "image" | "file";
    storedName: string;
    size: number;
  }>;
  runMetadata?: {
    providerId?: string;
    modelId?: string;
    connectionId?: string;
    outputTokens?: number;
    inputTokens?: number;
    inputTokensEstimated?: boolean;
    totalTokens?: number;
    costUsd?: number;
    completedAt: string;
  };
  createdAt: string;
};

export type MessagePart =
 | { type: "thinking"; content: string; done?: boolean; durationMs?: number }
 | ({ type: "tool" } & ToolPart)
 | {
 type: "compaction";
 id: string;
 name: "context_compaction";
 kind: "compaction";
 status: "started" | "completed" | "error";
 systemTriggered: true;
 beforeTokens?: number;
 targetTokens?: number;
 afterTokens?: number;
 removedMessages?: number;
 message?: string;
 }
 | { type: "text"; content: string };

export type WorkspaceItem = {
  id: string;
  type: "canvas" | "plan";
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  version?: number;
  scope?: "chat" | "global";
  idempotencyKey?: string;
};

export type NoteScope = "global" | "chat" | "workspace";
export type NoteAuthor = "user" | "agent";

export type NotePosition = {
  x: number;
  y: number;
};

export type NoteSize = {
  width: number;
  height: number;
};

export type NoteKind = "note" | "project";

export type NoteTodo = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  chatIds?: string[];
};

export type SharedNote = {
  id: string;
  ownerId?: string;
  chatId?: string;
  workspaceId?: string;
  scope: NoteScope;
  kind?: NoteKind;
  title: string;
  content: string;
  todos?: NoteTodo[];
  color: string;
  position: NotePosition;
  size: NoteSize;
  author: NoteAuthor;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  version: number;
  projectId?: string;
};

export type Project = {
  id: string;
  ownerId?: string;
  name: string;
  icon: string;
  color: string;
  instructions: string;
  memoryMode: "default" | "project_only";
  logoMimeType?: string;
  logoStoredName?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectFile = {
  id: string;
  projectId: string;
  ownerId?: string;
  name: string;
  mimeType: string;
  text?: string;
  storedName?: string;
  size: number;
  createdAt: string;
};

export type NoteActivity = {
  id: string;
  noteId: string;
  actor: NoteAuthor;
  action: "created" | "updated" | "archived" | "restored" | "deleted";
  createdAt: string;
  summary?: string;
  before?: SharedNote;
  after?: SharedNote;
};

export type SnapshotAvailability = "available" | "restored" | "needs_attention" | "not_available";

export type SessionSnapshot = {
  id: string;
  chatId: string;
  ownerId?: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  checkpoint: "important" | "periodic" | "shutdown" | "recovery";
  activeWorkspaceId?: string | null;
  workspaceTab?: ChatSessionState["workspaceTab"];
  workspaceOpen?: boolean;
  draft?: string;
  filters?: Record<string, string | boolean | number | null>;
  runStatus: ChatRunStatus;
  resumeMarker?: {
    jobId?: string;
    runId?: string;
    safe: boolean;
    reason?: string;
  };
  browser?: {
    tabs: BrowserTab[];
    activeTabId?: string;
    reachable: boolean;
  };
  terminals?: Array<{
    id: string;
    sessionId?: string;
    cwd: string;
    processId?: number;
    lastOutput?: string;
    exitCode?: number | null;
    running?: boolean;
    reachable: boolean;
  }>;
  notesView?: {
    x: number;
    y: number;
    zoom: number;
    selectedNoteId?: string | null;
  };
  availability: SnapshotAvailability;
  migration?: {
    fromVersion?: number;
    warnings?: string[];
  };
};

export type VoiceInputSettings = {
  enabled: boolean;
  maxDurationSeconds: number;
  provider: "openai" | "local" | "custom" | "browser";
  modelId: string;
  realtime: boolean;
  endpoint?: string;
  connectionId?: string;
  language?: string;
  autoInsertDraft: boolean;
  deleteAudioAfterTranscription: boolean;
};

export type VoiceJobStatus = "queued" | "uploading" | "transcribing" | "completed" | "failed" | "cancelled";

export type VoiceTranscriptionJob = {
  id: string;
  ownerId?: string;
  chatId?: string;
  status: VoiceJobStatus;
  mimeType: string;
  durationSeconds: number;
  sizeBytes: number;
  transcript?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type BrowserTab = {
  id: string;
  title: string;
  url: string;
};

export type BrowserContext = {
  tabs: BrowserTab[];
  activeTabId: string;
  sessionKey: string;
  updatedAt: string;
};

export type PendingChatQuestion = {
  questionId: string;
  runId?: string;
  jobId?: string;
  version?: number;
  expiresAt?: string;
  status?: "waiting_for_user" | "answered" | "cancelled" | "expired";
  questions: Array<{
    id: string;
    question: string;
    multiple?: boolean;
    options?: Array<{ label: string; value?: string }>;
  }>;
};

export type ChatRunStatus =
  | "idle"
  | "running"
  | "paused"
  | "waiting_for_user"
  | "waiting_input"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted"
  | "error";

export type ChatBadge = "blue" | "red";

export type ChatShare = {
  id: string;
  active: boolean;
  passwordHash?: string;
  content?: {
    attachments?: boolean;
    thinking?: boolean;
    tools?: boolean;
    suggestions?: boolean;
    sources?: boolean;
    workspaces?: boolean;
  };
  createdAt: string;
  updatedAt: string;
};

export type ChatInputState = {
  composer: string;
  queuedFollowUps: Array<{ id: string; text: string; referenceText?: string }>;
  browserUrl?: string;
  extraFields?: Record<string, unknown>;
  updatedAt: string;
};

export type ChatSessionState = {
  input?: string;
  /** ISO timestamp for last-write-wins merge of composer text across devices. */
  inputUpdatedAt?: string;
  queuedUpdatedAt?: string;
  browserUrl?: string;
  browserUrlUpdatedAt?: string;
  extraFields?: Record<string, unknown>;
  remoteCwd?: string;
  terminalCwd?: string;
  fileCwd?: string;
  terminalSessionId?: string;
  terminalTabs?: TerminalTab[];
  activeTerminalTabId?: string;
  workspaceTab?: "canvas" | "plan" | "terminal" | "files" | "browser" | "monitor";
  activeWorkspaceId?: string | null;
  workspaceOpen?: boolean;
  workspaceWidth?: number;
  notesView?: SessionSnapshot["notesView"];
  pinnedNoteIds?: string[];
  unpinnedGlobalNoteIds?: string[];
  filters?: Record<string, string | boolean | number | null>;
  modeId?: string;
};

export type ToolPermissionCategory =
  | "read"
  | "write"
  | "terminal"
  | "browser"
  | "memory"
  | "remote"
  | "plan"
  | "subagent";

export type AgentMode = {
  id: string;
  name: string;
  description: string;
  icon: string;
  instructions: string;
  allowedCategories: ToolPermissionCategory[];
  toolOverrides?: Record<string, boolean>;
  builtIn?: boolean;
};

export type TerminalTab = {
  id: string;
  title: string;
  cwd: string;
  sessionId?: string;
};

export type Chat = {
  id: string;
  ownerId?: string;
  /** Incognito chats are temporary and never appear in normal chat indexes. */
  incognito?: boolean;
  expiresAt?: string;
  title: string;
  titleSource?: "default" | "user" | "agent";
  keywords?: string[];
  agentId?: string;
  /** Selected provider/model key for this chat. */
  modelId?: string;
  /** Cursor model params, e.g. [{ id: "fast", value: "true" }] */
  modelParams?: Array<{ id: string; value: string }>;
  messages: ChatMessage[];
  queuedMessages?: Array<{
    id: string;
    text: string;
    referenceText?: string;
    references?: ChatMessage["references"];
    attachments?: ChatMessage["attachments"];
  }>;
  canvas?: string;
  workspaces?: WorkspaceItem[];
  browserContext?: BrowserContext;
  /** Hidden from the regular chat list; opened from the owning automation run history. */
  automationId?: string;
  automationRunId?: string;
  automationName?: string;
  sessionState?: ChatSessionState;
  runStatus?: ChatRunStatus;
  runUpdatedAt?: string;
  queueMessage?: string;
  pendingQuestion?: PendingChatQuestion;
  badge?: ChatBadge;
  share?: ChatShare;
  pinned?: boolean;
  archived?: boolean;
  lastMessageSent?: string;
  createdAt: string;
  updatedAt: string;
  projectId?: string;
};

export type ChatIndexEntry = {
  id: string;
  ownerId?: string;
  title: string;
  keywords?: string[];
  updatedAt: string;
  createdAt: string;
  agentId?: string;
  modelId?: string;
  runStatus?: ChatRunStatus;
  runUpdatedAt?: string;
  queueMessage?: string;
  pendingQuestion?: PendingChatQuestion;
  badge?: ChatBadge;
  pinned?: boolean;
  archived?: boolean;
  lastMessageSent?: string;
  share?: Omit<ChatShare, "passwordHash">;
  projectId?: string;
};

export type Memory = {
  id: string;
  content: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
};

const DATA_DIR = config.dataDir;
const CHATS_DIR = path.join(DATA_DIR, "chats");
const INDEX_PATH = path.join(CHATS_DIR, "index.json");
const MEMORIES_PATH = path.join(DATA_DIR, "memories.json");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

export type GlobalModelSettings = {
  compression?: {
    enabled?: boolean;
    mode?: "lite" | "standard" | "aggressive" | "ultra" | "rtk" | "stacked";
    compressToolResults?: boolean;
    compressChatHistory?: boolean;
  };
  modelId?: string;
  modelParams?: Array<{ id: string; value: string }>;
  modelParamsByModel?: Record<string, Array<{ id: string; value: string }>>;
  subagentModelEnabled?: boolean;
  subagentModelId?: string;
  draftInput?: string;
  pinnedNoteIds?: string[];
  favoriteModelKeys?: string[];
  modelAliases?: Record<string, string>;
  browserRealtime?: boolean;
  browserFps?: number;
  browserViewportWidth?: number;
  browserViewportHeight?: number;
  voiceInput?: VoiceInputSettings;
  featureFlags?: {
    plans?: boolean;
    notes?: boolean;
    recovery?: boolean;
    askUserTimeout?: boolean;
    voiceInput?: boolean;
    browser?: boolean;
  };
  customModes?: AgentMode[];
  enabledSkills?: Record<string, boolean>;
};

function ensureDirs() {
  if (!existsSync(CHATS_DIR)) {
    mkdirSync(CHATS_DIR, { recursive: true });
  }
  if (!existsSync(INDEX_PATH)) {
    atomicWriteJson(INDEX_PATH, []);
  }
  if (!existsSync(MEMORIES_PATH)) {
    atomicWriteJson(MEMORIES_PATH, []);
  }
}

function atomicWriteJson(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = readFileSync(filePath, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function chatPath(id: string) {
  return path.join(CHATS_DIR, `${id}.json`);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeBrowserContext(
  context: BrowserContext | null | undefined,
): BrowserContext | undefined {
  if (!context || !Array.isArray(context.tabs)) return undefined;
  const tabs = context.tabs
    .filter(
      (tab) =>
        tab &&
        typeof tab.id === "string" &&
        typeof tab.title === "string" &&
        typeof tab.url === "string",
    )
    .slice(0, 20)
    .map((tab) => ({
      id: tab.id.slice(0, 200),
      title: tab.title.trim().slice(0, 200) || "New tab",
      url: tab.url.trim().slice(0, 4_000),
    }));
  if (!tabs.length) return undefined;
  return {
    tabs,
    activeTabId: tabs.some((tab) => tab.id === context.activeTabId)
      ? context.activeTabId
      : tabs[0].id,
    sessionKey:
      typeof context.sessionKey === "string"
        ? context.sessionKey.trim().slice(0, 200)
        : "",
    updatedAt: nowIso(),
  };
}

function sortIndex(entries: ChatIndexEntry[]) {
  return [...entries].sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

function upsertIndex(entry: ChatIndexEntry) {
  ensureDirs();
  const index = readJsonFile<ChatIndexEntry[]>(INDEX_PATH, []);
  const next = sortIndex([
    entry,
    ...index.filter((e) => e.id !== entry.id),
  ]);
  atomicWriteJson(INDEX_PATH, next);
  return next;
}

export function listChats(): ChatIndexEntry[] {
  ensureDirs();
  return sortIndex(readJsonFile<ChatIndexEntry[]>(INDEX_PATH, []));
}

export function listChatsForUser(ownerId?: string): ChatIndexEntry[] {
  const chats = listChats();
  return ownerId ? chats.filter((chat) => !chat.ownerId || chat.ownerId === ownerId) : chats;
}

export function getChat(id: string, ownerId?: string): Chat | null {
  ensureDirs();
  if (!id || id.includes("/") || id.includes("..")) return null;
  const chat = readJsonFile<Chat | null>(chatPath(id), null);
  if (!chat || chat.id !== id || (ownerId && chat.ownerId && chat.ownerId !== ownerId)) return null;
  return chat;
}

export function createChat(
  title = "New chat",
  browserContext?: BrowserContext,
  ownerId?: string,
): Chat {
  ensureDirs();
  const ts = nowIso();
  const safeBrowserContext = normalizeBrowserContext(browserContext);
  const chat: Chat = {
    id: randomUUID(),
    ...(ownerId ? { ownerId } : {}),
    title: title.trim() || "New chat",
    messages: [],
    ...(safeBrowserContext ? { browserContext: safeBrowserContext } : {}),
    createdAt: ts,
    updatedAt: ts,
  };
  atomicWriteJson(chatPath(chat.id), chat);
  upsertIndex({
    id: chat.id,
    ownerId: chat.ownerId,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    ...(chat.runStatus ? { runStatus: chat.runStatus } : {}),
    ...(chat.runUpdatedAt ? { runUpdatedAt: chat.runUpdatedAt } : {}),
  });
  return chat;
}

export function saveChat(chat: Chat): Chat {
  ensureDirs();
  const updated: Chat = { ...chat, updatedAt: nowIso() };
  atomicWriteJson(chatPath(updated.id), updated);
  upsertIndex({
    id: updated.id,
    ownerId: updated.ownerId,
    title: updated.title,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
    agentId: updated.agentId,
    modelId: updated.modelId,
  });
  return updated;
}

export function updateChat(
  id: string,
  patch: {
    title?: string;
    agentId?: string | null;
    modelId?: string | null;
    modelParams?: Array<{ id: string; value: string }> | null;
    queuedMessages?: Array<{
      id: string;
      text: string;
      referenceText?: string;
      references?: ChatMessage["references"];
    attachments?: ChatMessage["attachments"];
    }> | null;
    canvas?: string | null;
    workspaces?: WorkspaceItem[] | null;
    browserContext?: BrowserContext | null;
    runStatus?: ChatRunStatus;
    runUpdatedAt?: string | null;
    pendingQuestion?: PendingChatQuestion | null;
  },
  ownerId?: string,
): Chat | null {
  const chat = getChat(id, ownerId);
  if (!chat) return null;
  if (typeof patch.title === "string") {
    const title = patch.title.trim();
    if (title) chat.title = title;
  }
  if (patch.agentId === null) {
    delete chat.agentId;
  } else if (typeof patch.agentId === "string") {
    chat.agentId = patch.agentId.trim() || undefined;
  }
  if (patch.modelId === null) {
    delete chat.modelId;
  } else if (typeof patch.modelId === "string") {
    const next = patch.modelId.trim();
    if (next && next !== chat.modelId) {
      chat.modelId = next;
      // Model change needs a fresh agent session
      delete chat.agentId;
    }
  }
  if (patch.modelParams === null) {
    delete chat.modelParams;
    delete chat.agentId;
  } else if (Array.isArray(patch.modelParams)) {
    const next = patch.modelParams
      .filter((p) => p.id && typeof p.value === "string")
      .map((p) => ({ id: p.id.trim(), value: String(p.value) }));
    const prev = JSON.stringify(chat.modelParams ?? []);
    const serialized = JSON.stringify(next);
    if (prev !== serialized) {
      chat.modelParams = next;
      delete chat.agentId;
    }
  }
  if (patch.queuedMessages === null) {
    delete chat.queuedMessages;
  } else if (Array.isArray(patch.queuedMessages)) {
    chat.queuedMessages = patch.queuedMessages
      .filter((item) => item && typeof item.id === "string" && typeof item.text === "string")
      .map((item) => ({
        id: item.id.slice(0, 200),
        text: item.text.slice(0, 100_000),
        ...(typeof item.referenceText === "string" && item.referenceText.trim()
          ? { referenceText: item.referenceText.slice(0, 100_000) }
          : {}),
        ...(Array.isArray(item.references)
          ? {
              references: item.references
                .filter((reference) => reference && typeof reference.id === "string" && typeof reference.kind === "string" && typeof reference.label === "string")
                .slice(0, 20)
                .map((reference) => ({
                  kind: reference.kind.slice(0, 40),
                  id: reference.id.slice(0, 300),
                  label: reference.label.slice(0, 300),
                  ...(reference.source === "explicit" || reference.source === "pinned" ? { source: reference.source } : {}),
                  ...(typeof reference.detail === "string" ? { detail: reference.detail.slice(0, 500) } : {}),
                  ...(typeof reference.path === "string" ? { path: reference.path.slice(0, 4_000) } : {}),
                  ...(typeof reference.content === "string" ? { content: reference.content.slice(0, 8_000) } : {}),
                })),
            }
          : {}),
      }))
      .filter((item) => item.text.trim())
      .slice(0, 50);
  }
  if (patch.canvas === null) {
    delete chat.canvas;
  } else if (typeof patch.canvas === "string") {
    chat.canvas = patch.canvas.slice(0, 100_000);
  }
  if (patch.workspaces === null) {
    delete chat.workspaces;
  } else if (Array.isArray(patch.workspaces)) {
    chat.workspaces = patch.workspaces
      .filter((item) =>
        item &&
        typeof item.id === "string" &&
        (item.type === "canvas" || item.type === "plan") &&
        typeof item.name === "string" &&
        typeof item.content === "string" &&
        typeof item.createdAt === "string" &&
        typeof item.updatedAt === "string",
      )
      .slice(0, 20)
      .map((item) => ({
        id: item.id.slice(0, 200),
        type: item.type,
        name: item.name.trim().slice(0, 200) || (item.type === "plan" ? "Plan" : "Canvas"),
        content: item.content.slice(0, 100_000),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }));
  }
  if (patch.browserContext === null) {
    delete chat.browserContext;
  } else if (patch.browserContext) {
    const browserContext = normalizeBrowserContext(patch.browserContext);
    if (browserContext) chat.browserContext = browserContext;
  }
  if (patch.runStatus) {
    chat.runStatus = patch.runStatus;
    chat.runUpdatedAt = patch.runUpdatedAt || nowIso();
  } else if (patch.runUpdatedAt === null) {
    delete chat.runUpdatedAt;
  }
  if (patch.pendingQuestion === null) {
    delete chat.pendingQuestion;
  } else if (patch.pendingQuestion) {
    const questions = patch.pendingQuestion.questions
      .filter(
        (question) =>
          question &&
          typeof question.id === "string" &&
          typeof question.question === "string",
      )
      .slice(0, 10)
      .map((question) => ({
        id: question.id.slice(0, 200),
        question: question.question.slice(0, 4_000),
        ...(question.multiple ? { multiple: true } : {}),
        ...(question.options
          ? {
              options: question.options
                .filter(
                  (option) =>
                    option &&
                    typeof option.label === "string" &&
                    (option.value === undefined ||
                      typeof option.value === "string"),
                )
                .slice(0, 20)
                .map((option) => ({
                  label: option.label.slice(0, 500),
                  ...(option.value !== undefined
                    ? { value: option.value.slice(0, 500) }
                    : {}),
                })),
            }
          : {}),
      }));
    if (questions.length > 0) {
      chat.pendingQuestion = {
        questionId: patch.pendingQuestion.questionId.slice(0, 200),
        questions,
      };
    }
  }
  return saveChat(chat);
}

export function deleteChat(id: string, ownerId?: string): boolean {
  ensureDirs();
  if (ownerId && !getChat(id, ownerId)) return false;
  const file = chatPath(id);
  if (!existsSync(file)) {
    const index = readJsonFile<ChatIndexEntry[]>(INDEX_PATH, []);
    if (!index.some((e) => e.id === id)) return false;
  }
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    /* ignore */
  }
  const index = readJsonFile<ChatIndexEntry[]>(INDEX_PATH, []).filter(
    (e) => e.id !== id,
  );
  atomicWriteJson(INDEX_PATH, index);
  return true;
}

export function appendMessage(
  chatId: string,
  message: Omit<ChatMessage, "id" | "createdAt"> & {
    id?: string;
    createdAt?: string;
  },
): Chat | null {
  const chat = getChat(chatId);
  if (!chat) return null;
  const msg: ChatMessage = {
    id: message.id || randomUUID(),
    role: message.role,
    content: message.content,
    createdAt: message.createdAt || nowIso(),
  };
  if (typeof message.thinking === "string" && message.thinking.trim()) {
    msg.thinking = message.thinking;
  }
  if (Array.isArray(message.tools) && message.tools.length > 0) {
    msg.tools = message.tools;
  }
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    msg.attachments = message.attachments;
  }
  chat.messages.push(msg);
  return saveChat(chat);
}

export function upsertMessage(
  chatId: string,
  message: Omit<ChatMessage, "createdAt"> & { createdAt?: string },
): Chat | null {
  const chat = getChat(chatId);
  if (!chat) return null;
  const index = chat.messages.findIndex((item) => item.id === message.id);
  const next: ChatMessage = {
    ...message,
    createdAt: message.createdAt || chat.messages[index]?.createdAt || nowIso(),
  };
  if (index >= 0) chat.messages[index] = next;
  else chat.messages.push(next);
  return saveChat(chat);
}

export function titleFromMessage(content: string): string {
  const cleaned = content.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New chat";
  return cleaned.length > 48 ? `${cleaned.slice(0, 48)}…` : cleaned;
}

export function listMemories(): Memory[] {
  ensureDirs();
  return readJsonFile<Memory[]>(MEMORIES_PATH, []);
}

export function saveMemories(memories: Memory[]) {
  ensureDirs();
  atomicWriteJson(MEMORIES_PATH, memories);
}

export function getGlobalModelSettings(): GlobalModelSettings {
  ensureDirs();
  return readJsonFile<GlobalModelSettings>(SETTINGS_PATH, {});
}

export function saveGlobalModelSettings(settings: GlobalModelSettings): GlobalModelSettings {
  ensureDirs();
  const next = {
    ...(settings.modelId ? { modelId: settings.modelId } : {}),
    ...(settings.modelParams ? { modelParams: settings.modelParams } : {}),
    ...(settings.modelParamsByModel ? { modelParamsByModel: settings.modelParamsByModel } : {}),
  };
  atomicWriteJson(SETTINGS_PATH, next);
  return next;
}

export function createMemory(content: string, tags?: string[]): Memory {
  const ts = nowIso();
  const memory: Memory = {
    id: randomUUID(),
    content: content.trim(),
    tags: tags?.filter(Boolean),
    createdAt: ts,
    updatedAt: ts,
  };
  const all = listMemories();
  all.push(memory);
  saveMemories(all);
  return memory;
}

export function updateMemory(
  id: string,
  patch: { content?: string; tags?: string[] },
): Memory | null {
  const all = listMemories();
  const idx = all.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  const current = all[idx];
  if (typeof patch.content === "string") {
    current.content = patch.content.trim();
  }
  if (patch.tags) {
    current.tags = patch.tags.filter(Boolean);
  }
  current.updatedAt = nowIso();
  all[idx] = current;
  saveMemories(all);
  return current;
}

export function deleteMemory(id: string): boolean {
  const all = listMemories();
  const next = all.filter((m) => m.id !== id);
  if (next.length === all.length) return false;
  saveMemories(next);
  return true;
}

export function buildSystemContext(memories: Memory[]): string {
  const lines =
    memories.length === 0
      ? ["(none yet)"]
      : memories.map((m) => {
          const tags =
            m.tags && m.tags.length > 0 ? ` [tags: ${m.tags.join(", ")}]` : "";
          return `- ${m.content}${tags}`;
        });

  return `[SYSTEM CONTEXT — not shown to user as reply]
Memories:
${lines.join("\n")}

You MAY and SHOULD autonomously:
- Append/update memories by editing ${path.join(DATA_DIR, "memories.json")}. Keep valid JSON array of { id, content, tags?, createdAt, updatedAt }. Use new UUIDs for new entries; set createdAt/updatedAt to ISO timestamps.
- Write Cursor rules to ${path.join(config.agentCwd, ".cursor", "rules")}/*.mdc
- Write skills to ${path.join(config.agentCwd, ".cursor", "skills")}/<name>/SKILL.md
- Update ${path.join(config.agentCwd, "AGENTS.md")} when lasting preferences appear
When you learn a durable user preference or fact, save a memory immediately without asking.
[/SYSTEM CONTEXT]`;
}

export function getDataPaths() {
  return { DATA_DIR, CHATS_DIR, INDEX_PATH, MEMORIES_PATH };
}
