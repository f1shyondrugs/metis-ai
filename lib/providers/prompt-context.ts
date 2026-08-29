import { getChat, getGlobalModelSettings } from "@/lib/db-store";
import { projectContextBlock } from "@/lib/projects";
import {
  globalFactsForScope,
  loadContextScope,
  resolveScopeReferences,
} from "@/lib/context-scope";
import { skillsCatalogPrompt } from "@/lib/skills";
import { autoSkillActivationPrompt } from "@/lib/skill-routing";
import { METIS_SHARED_AGENT_CONTROL, toolContractPrompt } from "@/lib/agent-control";
import { metisAgentIdentity } from "@/lib/agent-identity";
import { retrieveRelevantFacts } from "@/lib/context-layers";
import { buildAttachmentPrompt } from "@/lib/uploads";
import type { AgentJob } from "@/lib/jobs";

export type ProviderPromptContext = {
  job: AgentJob;
  toolNames?: ReadonlyArray<string>;
  nativeTools?: boolean;
  provider?: string;
};

const EXPLICIT_CONTEXT_CHARS = 80_000;
const PINNED_CONTEXT_CHARS = 32_000;
const CHAT_FACT_CHARS = 10_000;
const GLOBAL_CONTEXT_CHARS = 10_000;

function boundedJoin(blocks: string[], maxChars: number) {
  let used = 0;
  const selected: string[] = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    const next = trimmed.length > remaining ? `${trimmed.slice(0, Math.max(0, remaining - 32))}\n[context clipped]` : trimmed;
    selected.push(next);
    used += next.length + 2;
  }
  return selected.join("\n\n");
}

function referenceBlock(reference: NonNullable<AgentJob["references"]>[number]) {
  return [
    `- [${reference.kind}] ${reference.label}`,
    reference.detail ? `  Detail: ${reference.detail}` : "",
    reference.path ? `  Path/URL: ${reference.path}` : "",
    reference.content ? `  Context:\n${reference.content}` : "",
  ].filter(Boolean).join("\n");
}

function factBlock(title: string, facts: ReadonlyArray<{ id: string; content: string }>, maxChars: number) {
  if (!facts.length) return "";
  const body = boundedJoin(
    facts.map((fact) => `- ${fact.id}: ${fact.content}`),
    maxChars,
  );
  return body ? `${title}:\n${body}` : "";
}

/**
 * Provider-neutral scoped instructions/context. This deliberately excludes the
 * persisted conversation transcript. Native runtimes combine it with their own
 * session; the custom harness combines it with Metis-managed messages.
 *
 * Context is layered: stable core + current task references + tool-driven repo map +
 * retrieved durable context + bounded chat working memory. Checkpoints/history are
 * owned by recovery/compaction and provider-native sessions, not replayed here.
 */
export function buildProviderPrompt(input: ProviderPromptContext): string {
  const job = input.job;
  const chat = getChat(job.chatId, job.userId);
  if (!chat) return metisAgentIdentity();
  const ownerId = job.userId ?? chat.ownerId;
  const incognito = Boolean(job.incognito || chat.incognito);

  const rawReferences = (job.references || []).map((reference) => ({
    ...reference,
    source: "explicit" as const,
  }));
  const resolvedReferences = resolveScopeReferences(ownerId, chat.id, rawReferences, incognito);
  const scope = loadContextScope({
    chatId: chat.id,
    ownerId,
    references: resolvedReferences,
    includeGlobal: !incognito,
  });
  const project = !incognito ? scope?.project : undefined;
  const globalFacts = incognito
    ? []
    : globalFactsForScope({
        chatId: chat.id,
        ownerId,
        includeGlobal: project?.memoryMode !== "project_only",
      });

  const explicit = boundedJoin([
    ...resolvedReferences.map(referenceBlock),
    job.referenceText ? `Referenced context:\n${job.referenceText}` : "",
    buildAttachmentPrompt(job.chatId, job.attachments, ownerId),
  ], EXPLICIT_CONTEXT_CHARS);

  const pinned = boundedJoin([
    ...(scope?.pinnedNotes || []).map((note) =>
      `- [note] ${note.title || "Untitled note"}\n  Context:\n${note.content}`,
    ),
  ], PINNED_CONTEXT_CHARS);

  const retrievalQuery = [
    job.message,
    job.referenceText,
    ...resolvedReferences.flatMap((reference) => [reference.label, reference.detail, reference.path]),
    project?.name,
  ].filter((value): value is string => Boolean(value?.trim())).join("\n");

  // T3-style context ownership: the active native provider session owns raw
  // history and compaction. Metis layers only the durable slices needed now.
  // Both chat and global durable memory are relevance-only. Native sessions
  // already own vague follow-ups; stateless providers retain bounded history.
  // A recent-fact fallback would inject unrelated short-term state.
  const workingFacts = retrieveRelevantFacts(retrievalQuery, scope?.learnedFacts || [], {
    limit: 8,
    fallback: 0,
  });
  const retrievedGlobalFacts = retrieveRelevantFacts(retrievalQuery, globalFacts, {
    limit: 8,
    fallback: 0,
  });

  const workingBlock = factBlock("Chat working memory", workingFacts, CHAT_FACT_CHARS);
  const projectBlock = project ? projectContextBlock(project, ownerId) : "";
  const globalBlock = factBlock("Retrieved global durable memory", retrievedGlobalFacts, GLOBAL_CONTEXT_CHARS);

  return [
    // Layer 1 — Core Context: stable identity, policy, mode and tool contract.
    metisAgentIdentity(),
    skillsCatalogPrompt(getGlobalModelSettings(ownerId)),
    autoSkillActivationPrompt(job.message, getGlobalModelSettings(ownerId), {
      hasVisualReference: Boolean(job.attachments?.some((attachment) => attachment.kind === "image")),
    }),
    "Working style: precise, technically fluent, proactive. Act with tools instead of narrating steps. Reply in the user's language. On clear orders decide and act; ask only when genuinely ambiguous or destructive.",
    "Execution efficiency: batch related read-only inspection instead of issuing many tiny calls; reuse the known project/repository cwd instead of rediscovering it; run targeted checks while iterating and the expensive full test/build pass only once after the working tree has stopped changing. Parallelize independent lightweight reads when safe, but do not run competing heavyweight builds. Keep progress narration to short milestone updates rather than one message per tool call.",
    METIS_SHARED_AGENT_CONTROL,
    toolContractPrompt({
      modeId: job.modeId || chat.sessionState?.modeId || "agent",
      provider: input.provider || "alternative-provider",
      toolNames: input.toolNames,
      nativeTools: Boolean(input.nativeTools),
    }),
    // Layer 2 — Task State lives in the provider's current user turn. Do not
    // duplicate job.message here. Explicit references are the only addendum.
    explicit ? `Task context — explicit references:\n${explicit}` : "",
    // Layer 3 — Repo Map is metadata/tool-driven, never a repository dump.
    "Repository map: the filesystem/repository is durable external memory. Search/index first, then read only relevant files and symbols; never replay a whole repository into model context.",
    // Layers 4/5 — Retrieved Context + Working Memory.
    pinned ? `Pinned chat context:\n${pinned}` : "",
    projectBlock ? `Project context:\n${projectBlock}` : "",
    workingBlock,
    globalBlock,
    // Layer 6 — Checkpoints are injected only by recovery/compaction code.
    // Layer 7 — Raw History stays provider-owned for native sessions; custom
    // harnesses use the bounded compaction pipeline instead of this prompt.
    incognito
      ? "Incognito mode: do not use chat/project/global durable memory or personal context. Explicit references supplied in this request remain allowed."
      : "Personal/context-hub data is retrieval-only: use its tools only when relevant and request the smallest useful slice. Do not dump private context into the prompt.",
  ].filter(Boolean).join("\n\n");
}
