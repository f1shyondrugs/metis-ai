import type {
  MetisRuntimeEvent,
  MetisRuntimeContentDeltaEvent,
  MetisRuntimeToolStartedEvent,
  MetisRuntimeToolCompletedEvent,
  MetisRuntimeRequestOpenedEvent,
  MetisRuntimeRequestRespondedEvent,
} from "@/lib/runtime/events";

export type TimelineItemKind =
  | "tool"
  | "reasoning"
  | "content"
  | "request"
  | "turn-boundary";

export interface TimelineToolItem {
  kind: "tool";
  itemId: string;
  name: string;
  toolKind?: string;
  status: "in_progress" | "completed" | "failed" | "declined";
  input?: unknown;
  output?: unknown;
  summary?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface TimelineReasoningItem {
  kind: "reasoning";
  itemId: string;
  text: string;
  done: boolean;
  durationMs?: number;
  startedAt: string;
  completedAt?: string;
}

export interface TimelineContentItem {
  kind: "content";
  itemId: string;
  contentKind: "assistant_text" | "reasoning_text" | "reasoning_summary_text" | "command_output" | "unknown";
  text: string;
  contentIndex?: number;
  updatedAt: string;
}

export interface TimelineRequestItem {
  kind: "request";
  requestId: string;
  requestKind: string;
  title?: string;
  detail?: string;
  options?: Array<{ id?: string; label: string; description?: string }>;
  args?: unknown;
  decision?: "accept" | "accept_for_session" | "accept_always" | "decline" | "cancel" | "answer";
  response?: unknown;
  openedAt: string;
  respondedAt?: string;
}

export interface TimelineTurnBoundaryItem {
  kind: "turn-boundary";
  turnId: string;
  startedAt: string;
  completedAt?: string;
  stopReason?: string;
}

export type TimelineItem =
  | TimelineToolItem
  | TimelineReasoningItem
  | TimelineContentItem
  | TimelineRequestItem
  | TimelineTurnBoundaryItem;

export interface TimelineState {
  items: TimelineItem[];
  lastEventSequence: number;
  pendingDeltas: Map<string, { kind: string; text: string; contentIndex?: number }>;
  pendingTools: Map<string, Partial<TimelineToolItem>>;
}

export const initialTimelineState: TimelineState = {
  items: [],
  lastEventSequence: 0,
  pendingDeltas: new Map(),
  pendingTools: new Map(),
};

function findItemIndex(state: TimelineState, itemId: string): number {
  return state.items.findIndex((item) => "itemId" in item && item.itemId === itemId);
}

function findToolIndex(state: TimelineState, itemId: string): number {
  return state.items.findIndex(
    (item) => item.kind === "tool" && item.itemId === itemId,
  );
}

function findRequestIndex(state: TimelineState, requestId: string): number {
  return state.items.findIndex(
    (item) => item.kind === "request" && item.requestId === requestId,
  );
}

function findTurnBoundaryIndex(state: TimelineState, turnId: string): number {
  return state.items.findIndex(
    (item) => item.kind === "turn-boundary" && item.turnId === turnId,
  );
}

function getOrCreateTool(state: TimelineState, itemId: string, startedAt: string): TimelineToolItem {
  const existing = state.pendingTools.get(itemId);
  if (existing) {
    return { kind: "tool", itemId, status: "in_progress", startedAt, ...existing } as TimelineToolItem;
  }
  return { kind: "tool", itemId, status: "in_progress", startedAt, name: "" };
}

function upsertItem(state: TimelineState, item: TimelineItem): void {
  if (item.kind === "tool") {
    const idx = findToolIndex(state, item.itemId);
    if (idx >= 0) state.items[idx] = item;
    else state.items.push(item);
  } else if (item.kind === "reasoning") {
    const idx = findItemIndex(state, item.itemId);
    if (idx >= 0) state.items[idx] = item;
    else state.items.push(item);
  } else if (item.kind === "content") {
    const idx = findItemIndex(state, item.itemId);
    if (idx >= 0) state.items[idx] = item;
    else state.items.push(item);
  } else if (item.kind === "request") {
    const idx = findRequestIndex(state, item.requestId);
    if (idx >= 0) state.items[idx] = item;
    else state.items.push(item);
  } else if (item.kind === "turn-boundary") {
    const idx = findTurnBoundaryIndex(state, item.turnId);
    if (idx >= 0) state.items[idx] = item;
    else state.items.push(item);
  }
}

export function reduceTimeline(state: TimelineState, event: MetisRuntimeEvent, sequence: number): TimelineState {
  const newState = { ...state, lastEventSequence: sequence, items: [...state.items] };

  switch (event.type) {
    case "item.tool.started": {
      const toolEvent = event as MetisRuntimeToolStartedEvent;
      const itemId = toolEvent.itemId || toolEvent.eventId;
      const tool = getOrCreateTool(newState, itemId, toolEvent.createdAt);
      tool.name = toolEvent.payload.name;
      tool.toolKind = toolEvent.payload.kind;
      tool.input = toolEvent.payload.input;
      tool.summary = toolEvent.payload.summary;
      newState.pendingTools.set(itemId, tool);
      upsertItem(newState, tool);
      break;
    }

    case "item.tool.completed": {
      const toolEvent = event as MetisRuntimeToolCompletedEvent;
      const itemId = toolEvent.itemId || toolEvent.eventId;
      const pending = newState.pendingTools.get(itemId);
      const tool: TimelineToolItem = {
        kind: "tool",
        itemId,
        name: toolEvent.payload.name || pending?.name || "",
        toolKind: toolEvent.payload.kind || pending?.toolKind,
        status: toolEvent.payload.status,
        input: pending?.input,
        output: toolEvent.payload.output,
        summary: toolEvent.payload.summary,
        error: toolEvent.payload.error,
        startedAt: pending?.startedAt || toolEvent.createdAt,
        completedAt: toolEvent.createdAt,
      };
      newState.pendingTools.delete(itemId);
      upsertItem(newState, tool);
      break;
    }

    case "content.delta": {
      const deltaEvent = event as MetisRuntimeContentDeltaEvent;
      const itemId = deltaEvent.itemId || deltaEvent.eventId;
      const key = `${itemId}:${deltaEvent.payload.contentIndex ?? 0}`;
      const existing = newState.pendingDeltas.get(key);
      const mergedText = (existing?.text || "") + deltaEvent.payload.delta;
      newState.pendingDeltas.set(key, {
        kind: deltaEvent.payload.kind,
        text: mergedText,
        contentIndex: deltaEvent.payload.contentIndex,
      });
      upsertItem(newState, {
        kind: "content",
        itemId,
        contentKind: deltaEvent.payload.kind,
        text: mergedText,
        contentIndex: deltaEvent.payload.contentIndex,
        updatedAt: deltaEvent.createdAt,
      });
      break;
    }

    case "request.opened": {
      const reqEvent = event as MetisRuntimeRequestOpenedEvent;
      const requestId = reqEvent.requestId || reqEvent.eventId;
      upsertItem(newState, {
        kind: "request",
        requestId,
        requestKind: reqEvent.payload.kind,
        title: reqEvent.payload.title,
        detail: reqEvent.payload.detail,
        options: reqEvent.payload.options,
        args: reqEvent.payload.args,
        openedAt: reqEvent.createdAt,
      });
      break;
    }

    case "request.responded": {
      const reqEvent = event as MetisRuntimeRequestRespondedEvent;
      const requestId = reqEvent.requestId || reqEvent.eventId;
      const idx = findRequestIndex(newState, requestId);
      if (idx >= 0) {
        const item = newState.items[idx] as TimelineRequestItem;
        newState.items[idx] = {
          ...item,
          decision: reqEvent.payload.decision,
          response: reqEvent.payload.response,
          respondedAt: reqEvent.createdAt,
        };
      }
      break;
    }

    case "turn.started": {
      upsertItem(newState, {
        kind: "turn-boundary",
        turnId: event.turnId || event.eventId,
        startedAt: event.createdAt,
      });
      break;
    }

    case "turn.completed": {
      const turnId = event.turnId || event.eventId;
      const idx = findTurnBoundaryIndex(newState, turnId);
      if (idx >= 0) {
        const item = newState.items[idx] as TimelineTurnBoundaryItem;
        newState.items[idx] = {
          ...item,
          completedAt: event.createdAt,
          stopReason: event.payload.stopReason,
        };
      } else {
        upsertItem(newState, {
          kind: "turn-boundary",
          turnId,
          startedAt: event.createdAt,
          completedAt: event.createdAt,
          stopReason: event.payload.stopReason,
        });
      }
      break;
    }

    case "turn.failed": {
      const turnId = event.turnId || event.eventId;
      const idx = findTurnBoundaryIndex(newState, turnId);
      if (idx >= 0) {
        const item = newState.items[idx] as TimelineTurnBoundaryItem;
        newState.items[idx] = {
          ...item,
          completedAt: event.createdAt,
          stopReason: "failed",
        };
      }
      break;
    }
  }

  return newState;
}

export function reduceTimelineBatch(
  state: TimelineState,
  events: Array<{ event: MetisRuntimeEvent; sequence: number }>,
): TimelineState {
  return events.reduce((acc, { event, sequence }) => reduceTimeline(acc, event, sequence), state);
}