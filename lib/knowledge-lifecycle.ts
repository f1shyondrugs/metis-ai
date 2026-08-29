import {
  createMemory,
  getChat,
  listMemories,
  normalizeChatKeywords,
  updateChat,
  updateMemory,
} from "@/lib/db-store";
import { createNote, listNotes, updateNote } from "@/lib/shared-context";

export type KnowledgeClass = "durable" | "task" | "ephemeral";

export type KnowledgeCandidate = {
  kind: Exclude<KnowledgeClass, "ephemeral">;
  content: string;
  key: string;
  tags: string[];
};

const STOP_WORDS = new Set([
  "aber", "also", "auch", "auf", "aus", "bei", "bin", "bis", "bitte", "dann", "das", "dass", "dem", "den", "der", "die", "dir", "du", "ein", "eine", "einer", "eines", "er", "es", "für", "ganz", "hat", "haben", "ich", "im", "in", "ist", "ja", "kann", "mal", "man", "mehr", "mein", "meine", "meiner", "meinem", "meinen", "mit", "muss", "nach", "nicht", "noch", "nur", "oder", "sein", "sie", "so", "und", "uns", "von", "war", "was", "wenn", "wie", "wir", "zu", "zum", "zur",
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "for", "from", "has", "have", "how", "i", "if", "in", "is", "it", "me", "my", "of", "on", "or", "our", "that", "the", "this", "to", "use", "was", "we", "what", "when", "with", "you", "your",
]);

const VALUE_WORDS = new Set([
  "am", "are", "bin", "bleibt", "brauche", "brauchst", "habe", "haben", "has", "hat", "have", "is", "ist", "mag", "möchte", "nutze", "nutzt", "prefer", "prefers", "should", "soll", "sollen", "use", "uses", "verwende", "verwendet", "will", "wants",
]);

const EPHEMERAL = /\b(heute|morgen|gestern|jetzt|gerade|aktuell|momentan|diesmal|gleich|später|vorhin|diese[rmn]?\s+woche|nächste[rmn]?\s+woche|heute\s+abend|today|tomorrow|yesterday|right\s+now|currently|at\s+the\s+moment|this\s+time|this\s+week|next\s+week|later)\b/i;
const LONG_TERM_OVERRIDE = /\b(ab\s+jetzt|zukünftig|künftig|immer|standardmäßig|standardmaessig|dauerhaft|für\s+immer|in\s+zukunft|from\s+now\s+on|in\s+future|always|by\s+default|permanently)\b/i;
const EXPLICIT_REMEMBER = /\b(merk(?:e)?\s+(?:dir\s+)?(?:das|dass)?|speicher(?:e)?\s+(?:dir\s+)?(?:das|dass)?|remember\s+(?:that|this)?|save\s+(?:that|this)?\s+(?:as\s+memory)?)\b/i;
const PREFERENCE = /\b(ich\s+(?:bevorzuge|mag|möchte|will)\b|mir\s+ist\s+wichtig\b|mein\s+standard\b|i\s+(?:prefer|like|want)\b|my\s+default\b)/i;
const STABLE_FACT = /\b(ich\s+(?:heiße|heisse|wohne|nutze|verwende|habe|spiele|arbeite)\b|mein(?:e|er|em|en)?\s+[^.!?]{1,70}\s+(?:ist|sind|hat|haben|nutzt|verwendet)\b|i\s+(?:am|live|use|have|play|work)\b|my\s+[^.!?]{1,70}\s+(?:is|are|has|uses)\b)/i;
const TASK_SCOPE = /\b(metis|projekt|project|repo|repository|codebase|app|website|webseite|ui|server|agent|modell|model|workflow|automation|diesem\s+chat|this\s+chat)\b/i;
const REQUIREMENT = /\b(soll(?:en)?|muss|müssen|darf\s+nicht|immer|nie|standardmäßig|needs?\s+to|must|should|shouldn['’]?t|never|always|by\s+default)\b/i;
const QUESTION_START = /^(wer|wie|was|wann|wo|warum|wieso|weshalb|welche[rmn]?|kann|können|ist|sind|hat|haben|do|does|did|is|are|can|could|should|what|when|where|why|how|which)\b/i;
const SENSITIVE = /\b(passwort|password|api[_ -]?key|secret|token|cookie|bearer|refresh[_ -]?token|access[_ -]?token|pin|tan|2fa|otp|private[_ -]?key|credit\s*card|kreditkarte|cvv|security\s*code)\b/i;
const CODEISH = /```|\b(?:curl|npm|pnpm|yarn|git|sudo|ssh)\s+[^\n]+|[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|py|json|yaml|yml)\b/;

function normalized(value: string) {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}._/-]+/gu, " ")
    .trim();
}

function terms(value: string, options: { stripValues?: boolean } = {}) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of normalized(value).split(/\s+/)) {
    if (!token || token.length < 3 || STOP_WORDS.has(token)) continue;
    if (/^\d+(?:[.,]\d+)?(?:gb|tb|mb|mhz|ghz|€|eur|usd)?$/i.test(token)) continue;
    if (options.stripValues && VALUE_WORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function splitStatements(message: string) {
  const withoutCode = message.replace(/```[\s\S]*?```/g, " ");
  return withoutCode
    .split(/(?:\r?\n)+|(?<=[.!?])\s+/)
    .map((part) => part.trim().replace(/^[-*•\d.)\s]+/, ""))
    .filter((part) => part.length >= 12 && part.length <= 900)
    .slice(0, 24);
}

function candidateKey(kind: KnowledgeCandidate["kind"], content: string) {
  const anchors = terms(content, { stripValues: true }).slice(0, 8);
  return `${kind}:${anchors.join("-") || normalized(content).slice(0, 80)}`.slice(0, 140);
}

function candidateTags(kind: KnowledgeCandidate["kind"], content: string) {
  return ["auto:knowledge", `knowledge:${kind}`, ...terms(content).slice(0, 5)].slice(0, 8);
}

function classifyStatement(statement: string): KnowledgeClass {
  const text = statement.trim();
  if (!text || text.endsWith("?") || QUESTION_START.test(text)) return "ephemeral";
  if (SENSITIVE.test(text) || CODEISH.test(text)) return "ephemeral";
  if (EPHEMERAL.test(text) && !LONG_TERM_OVERRIDE.test(text)) return "ephemeral";
  // Project/app requirements stay scoped to the chat even when they are
  // long-lived ("Metis should always …"). They are not global user facts.
  if (TASK_SCOPE.test(text) && REQUIREMENT.test(text) && !PREFERENCE.test(text) && !STABLE_FACT.test(text)) return "task";
  if (EXPLICIT_REMEMBER.test(text) || LONG_TERM_OVERRIDE.test(text) || PREFERENCE.test(text) || STABLE_FACT.test(text)) {
    return "durable";
  }
  return "ephemeral";
}

export function extractKnowledgeCandidates(message: string): KnowledgeCandidate[] {
  const seen = new Set<string>();
  const candidates: KnowledgeCandidate[] = [];
  for (const statement of splitStatements(message)) {
    const kind = classifyStatement(statement);
    if (kind === "ephemeral") continue;
    const content = statement.replace(/\s+/g, " ").trim().slice(0, 900);
    const signature = normalized(content);
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    candidates.push({
      kind,
      content,
      key: candidateKey(kind, content),
      tags: candidateTags(kind, content),
    });
    if (candidates.length >= 6) break;
  }
  return candidates;
}

function similarity(a: string, b: string) {
  const left = new Set(terms(a, { stripValues: true }));
  const right = new Set(terms(b, { stripValues: true }));
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const term of left) if (right.has(term)) overlap += 1;
  return overlap / Math.max(left.size, right.size);
}

function upsertDurable(ownerId: string | undefined, candidate: KnowledgeCandidate) {
  const memories = listMemories(ownerId);
  const exact = memories.find((memory) => normalized(memory.content) === normalized(candidate.content));
  if (exact) return exact;
  const auto = memories
    .filter((memory) => memory.tags?.includes("auto:knowledge"))
    .map((memory) => ({ memory, score: similarity(memory.content, candidate.content) }))
    .filter((entry) => entry.score >= 0.78)
    .sort((a, b) => b.score - a.score)[0];
  if (auto) {
    return updateMemory(auto.memory.id, {
      content: candidate.content,
      tags: normalizeChatKeywords([...(auto.memory.tags || []), ...candidate.tags]),
    }, ownerId);
  }
  return createMemory(candidate.content, candidate.tags, ownerId);
}

function upsertTaskFact(ownerId: string | undefined, chatId: string, candidate: KnowledgeCandidate, messageId?: string) {
  const facts = listNotes({ ownerId, chatId, scope: "chat" }).filter((note) => note.kind === "learned_fact");
  const exact = facts.find((fact) => normalized(fact.content) === normalized(candidate.content));
  if (exact) return exact;
  const near = facts
    .map((fact) => ({ fact, score: similarity(fact.content, candidate.content) }))
    .filter((entry) => entry.score >= 0.82)
    .sort((a, b) => b.score - a.score)[0];
  const idempotencyKey = `knowledge:${chatId}:${messageId || normalized(candidate.content).slice(0, 80)}:${candidate.key}`.slice(0, 240);
  if (near) {
    return updateNote(near.fact.id, {
      ownerId,
      content: candidate.content,
      title: `Knowledge: ${candidate.key}`.slice(0, 200),
      author: "agent",
      idempotencyKey,
    });
  }
  return createNote({
    ownerId,
    chatId,
    scope: "chat",
    kind: "learned_fact",
    title: `Knowledge: ${candidate.key}`.slice(0, 200),
    content: candidate.content,
    author: "agent",
    idempotencyKey,
  });
}

export function deriveChatKeywords(message: string, limit = 6) {
  if (SENSITIVE.test(message)) return [];
  const counts = new Map<string, number>();
  for (const token of terms(message)) {
    if (token.length > 40 || /^https?$/i.test(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, limit))
    .map(([token]) => token);
}

/**
 * Deterministic, token-free knowledge capture for real user turns.
 * - durable: global memory, deduped/updated conservatively
 * - task: chat-scoped learned fact
 * - ephemeral/questions/secrets/code: never persisted as knowledge
 * External repo/browser/tool output is deliberately not copied into memory;
 * those systems stay durable external memory and are retrieved on demand.
 */
export function captureKnowledgeFromUserTurn(input: {
  chatId: string;
  ownerId?: string;
  message: string;
  messageId?: string;
  incognito?: boolean;
}) {
  if (input.incognito || !input.message.trim()) return { durable: 0, task: 0, keywords: 0 };
  const chat = getChat(input.chatId, input.ownerId);
  if (!chat || chat.incognito) return { durable: 0, task: 0, keywords: 0 };

  const candidates = extractKnowledgeCandidates(input.message);
  let durable = 0;
  let task = 0;
  for (const candidate of candidates) {
    if (candidate.kind === "durable") {
      upsertDurable(input.ownerId ?? chat.ownerId, candidate);
      durable += 1;
    } else {
      upsertTaskFact(input.ownerId ?? chat.ownerId, chat.id, candidate, input.messageId);
      task += 1;
    }
  }

  const keywords = deriveChatKeywords(input.message);
  if (keywords.length) {
    updateChat(chat.id, {
      keywords: normalizeChatKeywords([...(chat.keywords || []), ...keywords]),
    }, input.ownerId ?? chat.ownerId);
  }
  return { durable, task, keywords: keywords.length };
}
