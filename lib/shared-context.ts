import { randomUUID } from "node:crypto";
import { getDatabase, isSqliteForeignKeyError, parseData, transaction, withSqliteRetry } from "@/lib/sqlite";
import type {
  NoteActivity,
  NoteAuthor,
  NoteKind,
  NoteScope,
  NoteTodo,
  SessionSnapshot,
  SharedNote,
  VoiceInputSettings,
  VoiceJobStatus,
  VoiceTranscriptionJob,
} from "@/lib/store";

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const DEFAULT_ASK_USER_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_VOICE_DURATION_SECONDS = 3_600;
export const MAX_VOICE_BYTES = 250 * 1024 * 1024;
export const ALLOWED_AUDIO_MIME_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
]);

const iso = () => new Date().toISOString();

function idempotencyScope(scope: string, ownerId?: string) {
  return ownerId ? `${scope}:owner:${ownerId}` : scope;
}

function boundedText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validScope(value: unknown): value is NoteScope {
  return value === "global" || value === "chat" || value === "workspace";
}

function rowToNote(row: unknown): SharedNote | null {
  const parsed = parseData<SharedNote>(row);
  if (!parsed || typeof parsed.id !== "string" || !validScope(parsed.scope)) return null;
  return {
    ...parsed,
    title: boundedText(parsed.title, 200) || "Untitled note",
    content: boundedText(parsed.content, 50_000),
    color: /^#[0-9a-f]{6}$/i.test(parsed.color) ? parsed.color : "#fef08a",
    position: {
      x: Number.isFinite(parsed.position?.x) ? Math.max(-100_000, Math.min(100_000, parsed.position.x)) : 0,
      y: Number.isFinite(parsed.position?.y) ? Math.max(-100_000, Math.min(100_000, parsed.position.y)) : 0,
    },
    size: {
      width: Number.isFinite(parsed.size?.width) ? Math.max(160, Math.min(1_200, parsed.size.width)) : 280,
      height: Number.isFinite(parsed.size?.height) ? Math.max(120, Math.min(1_200, parsed.size.height)) : 220,
    },
    version: Math.max(1, Math.floor(parsed.version || 1)),
    archived: Boolean(parsed.archived),
  };
}

export function getIdempotentResponse<T>(scope: string, key: string, ownerId?: string, chatId?: string): T | null {
  if (!scope.trim() || !key.trim()) return null;
  const row = getDatabase().prepare(
    `SELECT response FROM idempotency_keys
     WHERE scope = ? AND key = ?
       AND (? IS NULL OR owner_id = ?)
       AND (? IS NULL OR chat_id = ?)`,
  ).get(idempotencyScope(scope, ownerId), key, ownerId ?? null, ownerId ?? null, chatId ?? null, chatId ?? null) as { response?: string } | undefined;
  if (!row?.response) return null;
  try {
    return JSON.parse(row.response) as T;
  } catch {
    return null;
  }
}

export function saveIdempotentResponse<T>(
  scope: string,
  key: string,
  response: T,
  ownerId?: string,
  chatId?: string,
) {
  const timestamp = iso();
  getDatabase().prepare(
    `INSERT INTO idempotency_keys (scope, key, owner_id, chat_id, response, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET response = excluded.response, updated_at = excluded.updated_at`,
  ).run(idempotencyScope(scope, ownerId), key, ownerId ?? null, chatId ?? null, JSON.stringify(response), timestamp, timestamp);
  return response;
}

export type NoteWriteInput = {
  title?: string;
  content?: string;
  color?: string;
  kind?: NoteKind;
  todos?: NoteTodo[];
  position?: { x?: number; y?: number };
  size?: { width?: number; height?: number };
  archived?: boolean;
  scope?: NoteScope;
  chatId?: string;
  workspaceId?: string;
  projectId?: string | null;
  author?: NoteAuthor;
  expectedVersion?: number;
};

export function normalizeNoteTodos(value: unknown): NoteTodo[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 80).flatMap((item, index) => {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : { content: String(item || "") };
    const content = String(entry.content || "").trim().slice(0, 300);
    if (!content) return [];
    const status = entry.status === "in_progress" || entry.status === "completed" ? entry.status : "pending";
    const chatIds = Array.isArray(entry.chatIds)
      ? entry.chatIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim().slice(0, 120)).slice(0, 40)
      : undefined;
    return [{
      id: String(entry.id || `todo-${index + 1}`).slice(0, 80),
      content,
      status,
      ...(chatIds?.length ? { chatIds } : {}),
    }];
  });
}

export class NoteConflictError extends Error {
  current?: SharedNote;

  constructor(current?: SharedNote) {
    super("The note was changed by another client.");
    this.name = "NoteConflict";
    this.current = current;
  }
}

export function listNotes(input: {
  ownerId?: string;
  chatId?: string;
  workspaceId?: string;
  scope?: NoteScope;
  includeArchived?: boolean;
  search?: string;
  projectId?: string;
}) {
  const rows = getDatabase().prepare(
    `SELECT data FROM notes
     WHERE (? IS NULL OR owner_id = ?)
       AND (? IS NULL OR scope = 'global' OR (scope = 'chat' AND chat_id = ?) OR (scope = 'workspace' AND workspace_id = ?))
       AND (? IS NULL OR scope = ?)
       AND (? = 1 OR archived = 0)
     ORDER BY updated_at DESC`,
  ).all(
    input.ownerId ?? null,
    input.ownerId ?? null,
    input.chatId ?? null,
    input.chatId ?? null,
    input.workspaceId ?? null,
    input.scope ?? null,
    input.scope ?? null,
    input.includeArchived ? 1 : 0,
  );
  const search = input.search?.trim().toLocaleLowerCase();
  return rows
    .map(rowToNote)
    .filter((note): note is SharedNote => Boolean(note))
    .filter((note) => !input.projectId || note.projectId === input.projectId)
    .filter((note) => !search || `${note.title}\n${note.content}`.toLocaleLowerCase().includes(search));
}

export function getNote(id: string, ownerId?: string, options?: { chatId?: string; workspaceId?: string }) {
  if (!id.trim()) return null;
  const chatId = options?.chatId?.trim();
  const workspaceId = options?.workspaceId?.trim();
  const row = getDatabase().prepare(
    `SELECT data FROM notes
     WHERE id = ?
       AND (? IS NULL OR owner_id = ?)
       AND (? IS NULL OR scope = 'global' OR (scope = 'chat' AND chat_id = ?) OR (scope = 'workspace' AND workspace_id = ?))`,
  ).get(id, ownerId ?? null, ownerId ?? null, (chatId || workspaceId) ?? null, chatId ?? null, workspaceId ?? null);
  return rowToNote(row);
}

function noteActivity(
  note: SharedNote,
  action: NoteActivity["action"],
  actor: NoteAuthor,
  summary?: string,
  before?: SharedNote,
) {
  const activity: NoteActivity = {
    id: randomUUID(),
    noteId: note.id,
    actor,
    action,
    createdAt: iso(),
    ...(summary ? { summary: boundedText(summary, 500) } : {}),
    ...(before ? { before, after: note } : { after: note }),
  };
  getDatabase().prepare(
    "INSERT INTO note_activities (id, note_id, owner_id, chat_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(activity.id, note.id, note.ownerId ?? null, note.chatId ?? null, JSON.stringify(activity), activity.createdAt);
  return activity;
}

export function listNoteActivities(noteId: string, ownerId?: string) {
  const rows = getDatabase().prepare(
    `SELECT data FROM note_activities
     WHERE note_id = ? AND (? IS NULL OR owner_id = ?)
     ORDER BY created_at DESC LIMIT 100`,
  ).all(noteId, ownerId ?? null, ownerId ?? null);
  return rows.map((row) => parseData<NoteActivity>(row)).filter((item): item is NoteActivity => Boolean(item));
}

export function createNote(input: NoteWriteInput & { ownerId?: string; idempotencyKey?: string }) {
  if (input.idempotencyKey) {
    const existing = getIdempotentResponse<SharedNote>("note:create", input.idempotencyKey, input.ownerId, input.chatId);
    if (existing) return existing;
  }
  const timestamp = iso();
  const note: SharedNote = {
    id: randomUUID(),
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    ...(input.chatId ? { chatId: input.chatId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    scope: input.scope || (input.workspaceId ? "workspace" : input.chatId ? "chat" : "global"),
    title: boundedText(input.title, 200) || (input.kind === "project" ? "Untitled project" : "Untitled note"),
    content: boundedText(input.content, 50_000),
    ...(input.kind === "project"
      ? { kind: "project" as const }
      : input.kind === "learned_fact"
        ? { kind: "learned_fact" as const }
        : { kind: "note" as const }),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(normalizeNoteTodos(input.todos).length ? { todos: normalizeNoteTodos(input.todos) } : {}),
    color: /^#[0-9a-f]{6}$/i.test(input.color || "") ? String(input.color) : "#fef08a",
    position: {
      x: Math.max(-100_000, Math.min(100_000, Number(input.position?.x) || 0)),
      y: Math.max(-100_000, Math.min(100_000, Number(input.position?.y) || 0)),
    },
    size: {
      width: Math.max(160, Math.min(1_200, Number(input.size?.width) || 280)),
      height: Math.max(120, Math.min(1_200, Number(input.size?.height) || 220)),
    },
    author: input.author || "user",
    createdAt: timestamp,
    updatedAt: timestamp,
    archived: Boolean(input.archived),
    version: 1,
  };
  transaction(() => {
    getDatabase().prepare(
      "INSERT INTO notes (id, owner_id, chat_id, workspace_id, scope, data, version, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(note.id, note.ownerId ?? null, note.chatId ?? null, note.workspaceId ?? null, note.scope, JSON.stringify(note), note.version, note.archived ? 1 : 0, timestamp, timestamp);
    noteActivity(note, "created", note.author);
  });
  return input.idempotencyKey
    ? saveIdempotentResponse("note:create", input.idempotencyKey, note, input.ownerId, input.chatId)
    : note;
}

export function updateNote(
  id: string,
  input: NoteWriteInput & { ownerId?: string; author?: NoteAuthor; idempotencyKey?: string },
) {
  if (input.idempotencyKey) {
    const existing = getIdempotentResponse<SharedNote>("note:update", input.idempotencyKey, input.ownerId);
    if (existing) return existing;
  }
  return transaction(() => {
    const current = getNote(id, input.ownerId);
    if (!current) return null;
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new NoteConflictError(current);
    }
    const timestamp = iso();
    const next: SharedNote = {
      ...current,
      ...(input.title !== undefined ? { title: boundedText(input.title, 200) || current.title } : {}),
      ...(input.content !== undefined ? { content: boundedText(input.content, 50_000) } : {}),
      ...(input.kind === "project" || input.kind === "note" ? { kind: input.kind } : {}),
    ...(input.projectId === null ? { projectId: undefined } : input.projectId ? { projectId: input.projectId } : {}),
      ...(input.todos !== undefined ? { todos: normalizeNoteTodos(input.todos) } : {}),
      ...(input.color !== undefined && /^#[0-9a-f]{6}$/i.test(input.color) ? { color: input.color } : {}),
      ...(input.position ? {
        position: {
          x: Math.max(-100_000, Math.min(100_000, Number(input.position.x) || current.position.x)),
          y: Math.max(-100_000, Math.min(100_000, Number(input.position.y) || current.position.y)),
        },
      } : {}),
      ...(input.size ? {
        size: {
          width: Math.max(160, Math.min(1_200, Number(input.size.width) || current.size.width)),
          height: Math.max(120, Math.min(1_200, Number(input.size.height) || current.size.height)),
        },
      } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
      updatedAt: timestamp,
      version: current.version + 1,
    };
    const changed = getDatabase().prepare(
      "UPDATE notes SET data = ?, version = ?, archived = ?, updated_at = ? WHERE id = ? AND version = ?",
    ).run(JSON.stringify(next), next.version, next.archived ? 1 : 0, timestamp, id, current.version);
    if (!changed.changes) throw new NoteConflictError(getNote(id, input.ownerId) || current);
    const action: NoteActivity["action"] = input.archived === true
      ? "archived"
      : input.archived === false
        ? "restored"
        : "updated";
    noteActivity(next, action, input.author || "user", undefined, current);
    return input.idempotencyKey
      ? saveIdempotentResponse("note:update", input.idempotencyKey, next, input.ownerId)
      : next;
  });
}

export function deleteNote(id: string, ownerId?: string) {
  return transaction(() => {
    const current = getNote(id, ownerId);
    if (!current) return false;
    getDatabase().prepare("DELETE FROM note_activities WHERE note_id = ?").run(id);
    getDatabase().prepare("DELETE FROM notes WHERE id = ?").run(id);
    return true;
  });
}

export function revertChatNotes(chatId: string, ownerId: string | undefined, cutoff: string) {
  return transaction(() => {
    const db = getDatabase();
    const rows = db.prepare(
      `SELECT a.id, a.note_id AS noteId, a.data
       FROM note_activities a
       JOIN notes n ON n.id = a.note_id
       WHERE n.chat_id = ? AND n.scope = 'chat'
         AND (? IS NULL OR n.owner_id = ?)
         AND a.created_at > ?
       ORDER BY a.created_at DESC`,
    ).all(chatId, ownerId ?? null, ownerId ?? null, cutoff) as Array<{
      id: string;
      noteId: string;
      data: string;
    }>;
    const reverted = new Set<string>();
    const deleted = new Set<string>();
    const restoreByNote = new Map<string, SharedNote>();
    for (const row of rows) {
      const activity = parseData<NoteActivity>({ data: row.data });
      if (!activity || deleted.has(row.noteId)) continue;
      if (activity.action === "created") {
        db.prepare("DELETE FROM note_activities WHERE note_id = ?").run(row.noteId);
        db.prepare("DELETE FROM notes WHERE id = ?").run(row.noteId);
        deleted.add(row.noteId);
        reverted.add(row.noteId);
        continue;
      }
      if (activity.before) restoreByNote.set(row.noteId, activity.before);
    }
    for (const [noteId, before] of restoreByNote) {
      if (deleted.has(noteId)) continue;
      const current = getNote(noteId, ownerId);
      if (!current) continue;
      const restored: SharedNote = { ...before, updatedAt: iso(), version: current.version + 1 };
      db.prepare(
        "UPDATE notes SET data = ?, version = ?, archived = ?, updated_at = ? WHERE id = ?",
      ).run(
        JSON.stringify(restored),
        restored.version,
        restored.archived ? 1 : 0,
        restored.updatedAt,
        restored.id,
      );
      db.prepare(
        "DELETE FROM note_activities WHERE note_id = ? AND created_at > ?",
      ).run(noteId, cutoff);
      reverted.add(noteId);
    }
    return [...reverted];
  });
}

function writeSnapshotRow(snapshot: SessionSnapshot) {
  const db = getDatabase();
  const serialized = JSON.stringify(snapshot);
  if (snapshot.checkpoint === "periodic") {
    const existing = db.prepare(
      `SELECT id FROM session_snapshots
       WHERE chat_id = ? AND checkpoint = 'periodic'
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(snapshot.chatId) as { id?: string } | undefined;
    if (existing?.id) {
      db.prepare(
        `UPDATE session_snapshots
         SET owner_id = ?, schema_version = ?, data = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        snapshot.ownerId ?? null,
        snapshot.schemaVersion,
        serialized,
        snapshot.updatedAt,
        existing.id,
      );
      return { ...snapshot, id: existing.id, createdAt: snapshot.createdAt };
    }
  }
  db.prepare(
    "INSERT INTO session_snapshots (id, chat_id, owner_id, schema_version, checkpoint, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(snapshot.id, snapshot.chatId, snapshot.ownerId ?? null, snapshot.schemaVersion, snapshot.checkpoint, serialized, snapshot.createdAt, snapshot.updatedAt);
  return snapshot;
}

export function saveSnapshot(snapshot: SessionSnapshot) {
  return withSqliteRetry(() => {
    try {
      return writeSnapshotRow(snapshot);
    } catch (error) {
      if (snapshot.ownerId && isSqliteForeignKeyError(error)) {
        const { ownerId: _ownerId, ...rest } = snapshot;
        return writeSnapshotRow(rest);
      }
      throw error;
    }
  });
}

export function getLatestSnapshot(chatId: string, ownerId?: string) {
  const rows = getDatabase().prepare(
    `SELECT data FROM session_snapshots
     WHERE chat_id = ? AND (? IS NULL OR owner_id = ?)
     ORDER BY updated_at DESC LIMIT 5`,
  ).all(chatId, ownerId ?? null, ownerId ?? null);
  for (const row of rows) {
    const snapshot = parseData<SessionSnapshot>(row);
    if (snapshot && snapshot.schemaVersion <= SNAPSHOT_SCHEMA_VERSION && snapshot.chatId === chatId) return snapshot;
  }
  return null;
}

export function createSnapshot(input: Omit<SessionSnapshot, "id" | "schemaVersion" | "createdAt" | "updatedAt">) {
  const timestamp = iso();
  return saveSnapshot({
    ...input,
    id: randomUUID(),
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function normalizeVoiceSettings(settings?: Partial<VoiceInputSettings>): VoiceInputSettings {
  const provider =
    settings?.provider === "local" ||
    settings?.provider === "custom" ||
    settings?.provider === "browser"
      ? settings.provider
      : "openai";
  const modelId = typeof settings?.modelId === "string" && settings.modelId.trim()
    ? settings.modelId.trim().slice(0, 200)
    : provider === "openai" && settings?.realtime
      ? "gpt-realtime-whisper"
      : "whisper-1";
  return {
    enabled: settings?.enabled !== false,
    maxDurationSeconds: Math.max(1, Math.min(MAX_VOICE_DURATION_SECONDS, Math.floor(Number(settings?.maxDurationSeconds) || 300))),
    provider,
    modelId,
    realtime: settings?.realtime === true,
    ...(typeof settings?.endpoint === "string" && settings.endpoint.trim()
      ? { endpoint: settings.endpoint.trim().slice(0, 500) }
      : {}),
    ...(typeof settings?.connectionId === "string" && settings.connectionId.trim()
      ? { connectionId: settings.connectionId.trim().slice(0, 120) }
      : {}),
    ...(settings?.language?.trim() ? { language: settings.language.trim().slice(0, 20) } : {}),
    autoInsertDraft: settings?.autoInsertDraft !== false,
    deleteAudioAfterTranscription: settings?.deleteAudioAfterTranscription !== false,
  };
}

export function createVoiceJob(input: {
  ownerId?: string;
  chatId?: string;
  mimeType: string;
  durationSeconds: number;
  sizeBytes: number;
  idempotencyKey?: string;
}) {
  if (!ALLOWED_AUDIO_MIME_TYPES.has(input.mimeType)) throw new Error("Unsupported audio MIME type.");
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0 || input.durationSeconds > MAX_VOICE_DURATION_SECONDS) {
    throw new Error(`Audio duration must be between 1 and ${MAX_VOICE_DURATION_SECONDS} seconds.`);
  }
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_VOICE_BYTES) {
    throw new Error("Audio file is too large.");
  }
  if (input.idempotencyKey) {
    const existing = getIdempotentResponse<VoiceTranscriptionJob>("voice:create", input.idempotencyKey, input.ownerId, input.chatId);
    if (existing) return existing;
  }
  const timestamp = iso();
  const job: VoiceTranscriptionJob = {
    id: randomUUID(),
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    ...(input.chatId ? { chatId: input.chatId } : {}),
    status: "queued",
    mimeType: input.mimeType,
    durationSeconds: input.durationSeconds,
    sizeBytes: input.sizeBytes,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  getDatabase().prepare(
    "INSERT INTO voice_jobs (id, owner_id, chat_id, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(job.id, job.ownerId ?? null, job.chatId ?? null, job.status, JSON.stringify(job), timestamp, timestamp);
  return input.idempotencyKey
    ? saveIdempotentResponse("voice:create", input.idempotencyKey, job, input.ownerId, input.chatId)
    : job;
}

export function getVoiceJob(id: string, ownerId?: string) {
  const row = getDatabase().prepare(
    "SELECT data FROM voice_jobs WHERE id = ? AND (? IS NULL OR owner_id = ?)",
  ).get(id, ownerId ?? null, ownerId ?? null);
  return parseData<VoiceTranscriptionJob>(row);
}

export function updateVoiceJob(id: string, patch: Partial<Pick<VoiceTranscriptionJob, "status" | "transcript" | "error">>, ownerId?: string) {
  const current = getVoiceJob(id, ownerId);
  if (!current) return null;
  const updated: VoiceTranscriptionJob = { ...current, ...patch, updatedAt: iso() };
  getDatabase().prepare("UPDATE voice_jobs SET status = ?, data = ?, updated_at = ? WHERE id = ?").run(updated.status, JSON.stringify(updated), updated.updatedAt, id);
  return updated;
}

export function listVoiceJobs(ownerId?: string, chatId?: string) {
  const rows = getDatabase().prepare(
    `SELECT data FROM voice_jobs
     WHERE (? IS NULL OR owner_id = ?)
       AND (? IS NULL OR chat_id = ?)
     ORDER BY updated_at DESC LIMIT 50`,
  ).all(ownerId ?? null, ownerId ?? null, chatId ?? null, chatId ?? null);
  return rows.map((row) => parseData<VoiceTranscriptionJob>(row)).filter((job): job is VoiceTranscriptionJob => Boolean(job));
}

export function isVoiceJobStatus(status: string): status is VoiceJobStatus {
  return ["queued", "uploading", "transcribing", "completed", "failed", "cancelled"].includes(status);
}
