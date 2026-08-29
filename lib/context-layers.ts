export type LayeredContextFact = {
  id: string;
  content: string;
  tags?: readonly string[];
  createdAt?: string;
  updatedAt?: string;
};

const STOP_WORDS = new Set([
  "aber", "also", "auch", "auf", "aus", "bei", "bin", "bis", "bitte", "das", "dass", "dem", "den", "der", "die", "dir", "du", "ein", "eine", "einer", "eines", "er", "es", "für", "ganz", "hat", "haben", "ich", "im", "in", "ist", "ja", "kann", "mal", "man", "mehr", "mit", "muss", "nach", "nicht", "noch", "nur", "oder", "sein", "sie", "so", "und", "uns", "von", "war", "was", "wenn", "wie", "wir", "zu", "zum", "zur",
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "for", "from", "has", "have", "how", "i", "if", "in", "is", "it", "me", "my", "of", "on", "or", "our", "that", "the", "this", "to", "use", "was", "we", "what", "when", "with", "you", "your",
]);

function normalized(value: string) {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}._/-]+/gu, " ")
    .trim();
}

function terms(value: string): string[] {
  const unique = new Set<string>();
  for (const token of normalized(value).split(/\s+/)) {
    if (!token || token.length < 3 || STOP_WORDS.has(token)) continue;
    unique.add(token);
  }
  return [...unique];
}

function timestamp(value?: string) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Select durable facts for the active turn instead of injecting the entire
 * memory store into every prompt. This is intentionally deterministic and
 * cheap: provider-native sessions own their live context, while Metis only
 * retrieves the small durable slice that overlaps the current task.
 */
export function retrieveRelevantFacts<T extends LayeredContextFact>(
  query: string,
  facts: readonly T[],
  options: { limit?: number; fallback?: number } = {},
): T[] {
  const limit = Math.max(0, options.limit ?? 8);
  if (!limit || !facts.length) return [];

  const queryTerms = terms(query);
  if (!queryTerms.length) {
    const fallback = Math.max(0, Math.min(limit, options.fallback ?? 0));
    return [...facts]
      .sort((a, b) => timestamp(b.updatedAt || b.createdAt) - timestamp(a.updatedAt || a.createdAt))
      .slice(0, fallback);
  }

  const querySet = new Set(queryTerms);
  const queryNormalized = normalized(query);
  const scored = facts.map((fact, index) => {
    const body = normalized(fact.content);
    const bodyTerms = new Set(terms(fact.content));
    const tagTerms = new Set(terms((fact.tags || []).join(" ")));
    let score = 0;

    for (const token of querySet) {
      if (tagTerms.has(token)) score += 8;
      if (bodyTerms.has(token)) score += 4;
      if (token.length >= 5 && body.includes(token)) score += 1;
    }

    for (const tag of fact.tags || []) {
      const value = normalized(tag);
      if (value.length >= 3 && queryNormalized.includes(value)) score += 10;
    }

    // Stable recency tie-break only. Relevance always wins over freshness.
    return { fact, score, updatedAt: timestamp(fact.updatedAt || fact.createdAt), index };
  });

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.fact);
}
