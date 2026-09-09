export type UserTextPart =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string }
  | { kind: "link"; text: string; href: string; label: string };

const MARKDOWN_LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>]+/gi;

function mentionPattern(labels: string[]) {
  if (!labels.length) return null;
  const escaped = labels
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`@(?:${escaped})`, "g");
}

function pushText(parts: UserTextPart[], text: string) {
  if (text) parts.push({ kind: "text", text });
}

/** Split a user message into mentions, markdown links, and bare https URLs. */
export function parseRichUserText(content: string, mentionLabels: string[] = []): UserTextPart[] {
  const mentions = mentionPattern(mentionLabels);
  type Hit = { start: number; end: number; part: UserTextPart };
  const hits: Hit[] = [];

  for (const match of content.matchAll(MARKDOWN_LINK)) {
    const start = match.index ?? 0;
    const href = match[2];
    const label = match[1];
    hits.push({
      start,
      end: start + match[0].length,
      part: { kind: "link", text: match[0], href, label },
    });
  }

  const covered = (start: number, end: number) =>
    hits.some((hit) => start < hit.end && end > hit.start);

  if (mentions) {
    for (const match of content.matchAll(mentions)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (covered(start, end)) continue;
      hits.push({ start, end, part: { kind: "mention", text: match[0] } });
    }
  }

  for (const match of content.matchAll(BARE_URL)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (covered(start, end)) continue;
    const href = match[0].replace(/[).,;:]+$/, "");
    hits.push({
      start,
      end: start + href.length,
      part: { kind: "link", text: href, href, label: href },
    });
  }

  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Hit[] = [];
  for (const hit of hits) {
    const last = merged.at(-1);
    if (last && hit.start < last.end) continue;
    merged.push(hit);
  }

  const parts: UserTextPart[] = [];
  let cursor = 0;
  for (const hit of merged) {
    if (hit.start > cursor) pushText(parts, content.slice(cursor, hit.start));
    parts.push(hit.part);
    cursor = hit.end;
  }
  if (cursor < content.length) pushText(parts, content.slice(cursor));
  return parts.length ? parts : [{ kind: "text", text: content }];
}
