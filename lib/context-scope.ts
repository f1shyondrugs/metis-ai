import {
  getChat,
  listMemories,
} from "@/lib/db-store";
import { getProject } from "@/lib/projects";
import {
  createNote,
  getNote,
  listNotes,
  type NoteWriteInput,
} from "@/lib/shared-context";
import type { Chat, ChatMessage, Memory, Project, SharedNote } from "@/lib/store";

export type ScopedContextReference = {
  kind: string;
  id: string;
  label: string;
  source: "explicit" | "pinned" | "chat" | "project" | "global";
  detail?: string;
  path?: string;
  content?: string;
};

export type ScopedLearnedFact = {
  id: string;
  content: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
};

export type ContextScope = {
  chatId: string;
  ownerId?: string;
  projectId?: string;
  incognito: boolean;
  notes: SharedNote[];
  pinnedNotes: SharedNote[];
  learnedFacts: ScopedLearnedFact[];
  project?: Project;
};

export type ContextScopeInput = {
  chatId: string;
  ownerId?: string;
  references?: ReadonlyArray<ScopedContextReference>;
  includeGlobal?: boolean;
};

const MAX_NOTE_CHARS = 8_000;
const MAX_REFERENCE_CHARS = 8_000;
const MAX_FACT_CHARS = 2_000;

function noteToReference(
  note: SharedNote,
  source: ScopedContextReference["source"],
): ScopedContextReference {
  return {
    kind: "note",
    id: note.id,
    label: note.title || "Untitled note",
    source,
    detail: source === "pinned" ? "Pinned note" : "Chat-scoped note",
    ...(note.chatId ? { content: note.content.slice(0, MAX_NOTE_CHARS) } : {}),
  };
}

function visibleNotes(ownerId: string | undefined, chatId: string, incognito: boolean) {
  if (incognito) return [];
  // Passing chatId makes the SQL scope filter explicit: global notes remain
  // available, while chat notes from another chat cannot enter this scope.
  return listNotes({ ownerId, chatId });
}

/**
 * Load the bounded context that belongs to this chat. The transcript remains
 * separate; this is only the scoped note/reference/project memory surface.
 */
export function loadContextScope(input: ContextScopeInput): ContextScope | null {
  const chat = getChat(input.chatId, input.ownerId);
  if (!chat) return null;

  const incognito = Boolean(chat.incognito);
  const notes = visibleNotes(input.ownerId, chat.id, incognito);
  const noteIds = new Set(notes.map((note) => note.id));
  const pinnedIds = [
    ...new Set(chat.sessionState?.pinnedNoteIds?.filter((id) => noteIds.has(id)) || []),
  ];
  const pinnedNotes = pinnedIds
    .map((id) => notes.find((note) => note.id === id))
    .filter((note): note is SharedNote => Boolean(note));

  const references = resolveScopeReferences(
    input.ownerId ?? chat.ownerId,
    chat.id,
    input.references || [],
    incognito,
  );
  const explicitNoteIds = new Set(
    references.filter((reference) => reference.source === "explicit" && reference.kind === "note").map((reference) => reference.id),
  );

  const project =
    !incognito && chat.projectId
      ? getProject(chat.projectId, input.ownerId ?? chat.ownerId)
      : undefined;

  return {
    chatId: chat.id,
    ownerId: input.ownerId ?? chat.ownerId,
    ...(chat.projectId ? { projectId: chat.projectId } : {}),
    incognito,
    notes: references
      .filter((reference) => reference.source === "explicit" && reference.kind === "note")
      .map((reference) => {
        const existing = notes.find((note) => note.id === reference.id);
        if (existing) return existing;
        return {
          id: reference.id,
          title: reference.label,
          content: reference.content || "",
          color: "#000000",
          position: { x: 0, y: 0 },
          size: { width: 280, height: 220 },
          scope: "chat" as const,
          kind: "note" as const,
          author: "user" as const,
          createdAt: "",
          updatedAt: "",
          version: 1,
          archived: false,
        };
      }),
    pinnedNotes,
    learnedFacts: incognito ? [] : learnedFactsForChat(chat),
    ...(project ? { project } : {}),
  };
}

function learnedFactsForChat(chat: Chat): ScopedLearnedFact[] {
  const notes = listNotes({
    ownerId: chat.ownerId,
    chatId: chat.id,
    scope: "chat",
  }).filter((note) => note.kind === LEARNED_FACT_KIND);
  const seen = new Set<string>();
  return notes
    .map((note): ScopedLearnedFact => ({
      id: note.id,
      content: note.content,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    }))
    .filter((fact) => {
      const key = fact.id || fact.content;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // Retrieval is relevance-ranked later, so keep a reasonably deep local
    // candidate pool without injecting it into model context. listNotes is
    // newest-first; the old slice(-20) accidentally kept only the oldest 20.
    .slice(0, 200);
}

/** Resolve only note references that are valid in this chat's scope. */
export function resolveScopeReferences(
  ownerId: string | undefined,
  chatId: string,
  references: ReadonlyArray<ScopedContextReference>,
  incognito = false,
): ScopedContextReference[] {
  const allowed = new Map(visibleNotes(ownerId, chatId, incognito).map((note) => [note.id, note]));
  return references
    .slice(0, 20)
    .map((reference): ScopedContextReference | null => {
      if (reference.kind !== "note") {
        return {
          ...reference,
          source: reference.source || "explicit",
          ...(reference.content ? { content: reference.content.slice(0, MAX_REFERENCE_CHARS) } : {}),
        };
      }
      const note = allowed.get(reference.id) ||
        (incognito
          ? getNote(reference.id, ownerId)
          : getNote(reference.id, ownerId, { chatId }));
      if (!note) return null;
      return {
        ...noteToReference(note, "explicit"),
        detail: reference.detail || "Referenced note",
      };
    })
    .filter((reference): reference is ScopedContextReference => Boolean(reference));
}

export function createChatNote(
  ownerId: string | undefined,
  chatId: string,
  input: Omit<NoteWriteInput, "chatId" | "scope" | "ownerId" | "projectId">,
) {
  const chat = getChat(chatId, ownerId);
  if (!chat) return null;
  return createNote({
    ...input,
    ownerId: ownerId ?? chat.ownerId,
    chatId: chat.id,
    projectId: chat.projectId,
    scope: "chat",
  });
}

const LEARNED_FACT_KIND = "learned_fact" as const;

export function addLearnedFact(
  ownerId: string | undefined,
  chatId: string,
  fact: { id?: string; content: string },
): ScopedLearnedFact | null {
  const chat = getChat(chatId, ownerId);
  if (!chat || chat.incognito) return null;
  const content = fact.content.trim().slice(0, MAX_FACT_CHARS);
  if (!content) return null;
  const timestamp = new Date().toISOString();
  const id = fact.id?.trim().slice(0, 120) || `fact-${timestamp}`;
  const learnedFact: ScopedLearnedFact = { id, content, createdAt: timestamp, updatedAt: timestamp };

  // Blocker: Schema change needed for dedicated learned_fact storage.
  // Currently stores as a chat-scoped note with kind=learned_fact to avoid
  // polluting conversation history with empty system messages.
  // Read side (learnedFactsForChat) now reads from notes, not message refs.
  createNote({
    ownerId: ownerId ?? chat.ownerId,
    chatId: chat.id,
    projectId: chat.projectId,
    scope: "chat",
    kind: LEARNED_FACT_KIND,
    title: `Learned fact: ${content.slice(0, 80)}`,
    content,
    author: "agent",
  });

  return learnedFact;
}

export function scopeFactsFromMemories(memories: readonly Memory[]): ScopedLearnedFact[] {
  return memories.map((memory) => ({
    id: memory.id,
    content: memory.content,
    ...(memory.tags?.length ? { tags: memory.tags } : {}),
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  }));
}

export function globalFactsForScope(input: ContextScopeInput): ScopedLearnedFact[] {
  const chat = getChat(input.chatId, input.ownerId);
  if (!chat || chat.incognito || input.includeGlobal === false) return [];
  const project = chat.projectId ? getProject(chat.projectId, input.ownerId ?? chat.ownerId) : null;
  if (project?.memoryMode === "project_only") return [];
  return scopeFactsFromMemories(listMemories(input.ownerId ?? chat.ownerId));
}
