import type { TimelineState, TimelineItem, TimelineToolItem, TimelineReasoningItem, TimelineRequestItem, TimelineContentItem } from "./reducer";

export function selectItemsByTurn(state: TimelineState, turnId: string): TimelineItem[] {
  return state.items.filter((item) => {
    if ("turnId" in item && item.turnId === turnId) return true;
    if ("itemId" in item) return true;
    return false;
  });
}

export function selectToolsForTurn(state: TimelineState, _turnId: string): TimelineToolItem[] {
  return state.items.filter((item): item is TimelineToolItem => item.kind === "tool");
}

export function selectRequestsForTurn(state: TimelineState, _turnId: string): TimelineRequestItem[] {
  return state.items.filter((item): item is TimelineRequestItem => item.kind === "request");
}

export function selectReasoningForTurn(state: TimelineState, _turnId: string): TimelineReasoningItem[] {
  return state.items.filter((item): item is TimelineReasoningItem => item.kind === "reasoning");
}

export function selectContentForTurn(state: TimelineState, _turnId: string): TimelineContentItem[] {
  return state.items.filter((item): item is TimelineContentItem => item.kind === "content");
}

export function selectTurnBoundaries(state: TimelineState) {
  return state.items.filter((item) => item.kind === "turn-boundary");
}

export function selectActiveTools(state: TimelineState): TimelineToolItem[] {
  return state.items.filter(
    (item): item is TimelineToolItem =>
      item.kind === "tool" && item.status === "in_progress",
  );
}

export function selectPendingRequests(state: TimelineState): TimelineRequestItem[] {
  return state.items.filter(
    (item): item is TimelineRequestItem =>
      item.kind === "request" && !item.respondedAt,
  );
}

export function selectTimelineForChat(
  state: TimelineState,
  _chatId: string,
  options?: { sinceSequence?: number; limit?: number },
): TimelineItem[] {
  let items = [...state.items].sort((a, b) => {
    const timeA = getItemTimestamp(a);
    const timeB = getItemTimestamp(b);
    return timeA.localeCompare(timeB);
  });

  if (options?.sinceSequence) {
    items = items.filter((item) => {
      const seq = getItemSequence(item);
      return seq > options.sinceSequence!;
    });
  }

  if (options?.limit) {
    items = items.slice(-options.limit);
  }

  return items;
}

function getItemTimestamp(item: TimelineItem): string {
  if ("startedAt" in item) return item.startedAt;
  if ("openedAt" in item) return item.openedAt;
  if ("updatedAt" in item) return item.updatedAt;
  return "";
}

function getItemSequence(item: TimelineItem): number {
  if ("sequence" in item && typeof item.sequence === "number") return item.sequence;
  return 0;
}

export function groupToolsByItemId(items: TimelineToolItem[]): Map<string, TimelineToolItem[]> {
  const groups = new Map<string, TimelineToolItem[]>();
  for (const item of items) {
    const existing = groups.get(item.itemId) || [];
    existing.push(item);
    groups.set(item.itemId, existing);
  }
  return groups;
}

export function selectLatestContentByKind(state: TimelineState, kind: string): string {
  const contentItems = state.items
    .filter((item): item is TimelineContentItem => item.kind === "content" && item.contentKind === kind)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  return contentItems[contentItems.length - 1]?.text || "";
}

export function selectContextPressurePayload(state: TimelineState) {
  return undefined;
}