/**
 * Canonical, provider-neutral runtime timeline contract.
 *
 * The shape deliberately follows t3's providerRuntime contract — identity
 * fields live on the event envelope and each event has a typed payload — but
 * this port remains plain TypeScript (no Effect schemas or provider types).
 * Adapters translate provider events into this vocabulary before publication;
 * the timeline never interprets provider-native messages.
 */
export type IsoDateTime = string;
export type EventId = string;
export type ChatId = string;
export type TurnId = string;
export type ItemId = string;
export type RequestId = string;
export type SessionId = string;

export type RuntimeTurnStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "cancelled"
  | "interrupted"
  | "unknown";

export type RuntimeToolStatus = "in_progress" | "completed" | "failed" | "declined";
export type RuntimeContentKind =
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "command_output"
  | "unknown";
export type RuntimeRequestKind =
  | "command_execution_approval"
  | "file_read_approval"
  | "file_change_approval"
  | "apply_patch_approval"
  | "mcp_elicitation"
  | "tool_user_input"
  | "auth"
  | "unknown";

export interface RuntimeRequestOption {
  id?: string;
  label: string;
  description?: string;
}

export interface ContextPressurePayload {
  usedTokens: number;
  totalTokens?: number;
  /** Present when the provider reports an explicit context budget. */
  effectiveTotalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalProcessedTokens?: number;
  compactsAutomatically?: boolean;
  autoCompactThreshold?: number;
  source?: "provider" | "estimate" | "compaction";
  message?: string;
}

export interface UsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface MetisRuntimeEventEnvelope {
  /** Monotonic ID used as the SSE event id and Last-Event-ID cursor. */
  eventId: EventId;
  chatId: ChatId;
  createdAt: IsoDateTime;
  turnId?: TurnId;
  itemId?: ItemId;
  requestId?: RequestId;
}

export interface MetisRuntimeSessionStartedEvent extends MetisRuntimeEventEnvelope {
  type: "session.started";
  payload: {
    sessionId?: SessionId;
    model?: string;
    /** Provider identity is optional while adapters are being migrated. */
    provider?: string;
    message?: string;
  };
}

export interface MetisRuntimeTurnStartedEvent extends MetisRuntimeEventEnvelope {
  type: "turn.started";
  payload: {
    model?: string;
    effort?: string;
  };
}

export interface MetisRuntimeTurnCompletedEvent extends MetisRuntimeEventEnvelope {
  type: "turn.completed";
  payload: {
    stopReason?: RuntimeTurnStopReason;
    usage?: UsagePayload;
  };
}

export interface MetisRuntimeTurnFailedEvent extends MetisRuntimeEventEnvelope {
  type: "turn.failed";
  payload: {
    message: string;
    code?: string;
    retryable?: boolean;
  };
}

export interface MetisRuntimeToolStartedEvent extends MetisRuntimeEventEnvelope {
  type: "item.tool.started";
  payload: {
    name: string;
    /** Provider-neutral presentation category from the durable tool event. */
    kind?: string;
    /** Short input representation for the compact chip. */
    input?: unknown;
    summary?: string;
  };
}

export interface MetisRuntimeToolCompletedEvent extends MetisRuntimeEventEnvelope {
  type: "item.tool.completed";
  payload: {
    name?: string;
    kind?: string;
    status: RuntimeToolStatus;
    output?: unknown;
    summary?: string;
    error?: string;
  };
}

export interface MetisRuntimeContentDeltaEvent extends MetisRuntimeEventEnvelope {
  type: "content.delta";
  payload: {
    kind: RuntimeContentKind;
    delta: string;
    contentIndex?: number;
  };
}

export interface MetisRuntimeRequestOpenedEvent extends MetisRuntimeEventEnvelope {
  type: "request.opened";
  payload: {
    kind: RuntimeRequestKind;
    title?: string;
    detail?: string;
    options?: RuntimeRequestOption[];
    args?: unknown;
  };
}

export interface MetisRuntimeRequestRespondedEvent extends MetisRuntimeEventEnvelope {
  type: "request.responded";
  payload: {
    kind: RuntimeRequestKind;
    decision?: "accept" | "accept_for_session" | "accept_always" | "decline" | "cancel" | "answer";
    response?: unknown;
  };
}

export interface MetisRuntimeContextPressureEvent extends MetisRuntimeEventEnvelope {
  type: "context.pressure";
  payload: ContextPressurePayload;
}

export type MetisRuntimeEvent =
  | MetisRuntimeSessionStartedEvent
  | MetisRuntimeTurnStartedEvent
  | MetisRuntimeTurnCompletedEvent
  | MetisRuntimeTurnFailedEvent
  | MetisRuntimeToolStartedEvent
  | MetisRuntimeToolCompletedEvent
  | MetisRuntimeContentDeltaEvent
  | MetisRuntimeRequestOpenedEvent
  | MetisRuntimeRequestRespondedEvent
  | MetisRuntimeContextPressureEvent;

export type MetisRuntimeEventType = MetisRuntimeEvent["type"];

export const METIS_RUNTIME_EVENT_TYPES: ReadonlySet<string> = new Set<MetisRuntimeEventType>([
  "session.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.tool.started",
  "item.tool.completed",
  "content.delta",
  "request.opened",
  "request.responded",
  "context.pressure",
]);

/** Validate event IDs and field identity without trying to parse payloads. */
export function isRuntimeEventIdentity(value: unknown): value is MetisRuntimeEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<MetisRuntimeEventEnvelope> & { type?: unknown; payload?: unknown };
  return (
    typeof event.type === "string" &&
    METIS_RUNTIME_EVENT_TYPES.has(event.type) &&
    typeof event.eventId === "string" &&
    event.eventId.trim().length > 0 &&
    typeof event.chatId === "string" &&
    event.chatId.trim().length > 0 &&
    typeof event.createdAt === "string" &&
    event.payload !== undefined
  );
}
