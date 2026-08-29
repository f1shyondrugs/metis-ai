import { getChat, updateChat } from "@/lib/db-store";
import type { Chat, ProviderSessionBinding } from "@/lib/store";
import type { ProviderExecution } from "@/lib/providers/run-kind";

export function providerSessionKey(execution: ProviderExecution, connectionId: string) {
  return `${execution}:${connectionId}`;
}

export function getProviderSessionBinding(
  chat: Pick<Chat, "sessionState"> | null | undefined,
  execution: ProviderExecution,
  connectionId: string,
): ProviderSessionBinding | undefined {
  return chat?.sessionState?.providerSessions?.[providerSessionKey(execution, connectionId)];
}

export function updateProviderSessionBinding(input: {
  chatId: string;
  ownerId?: string;
  execution: ProviderExecution;
  connectionId: string;
  contextOwner: "native" | "metis";
  candidateCursor?: string | null;
  promoteCursor?: boolean;
  modelId?: string;
  lastContextTokens?: number;
  lastContextWindow?: number;
  lastCompactionAt?: string;
  bumpRecoveryGeneration?: boolean;
}) {
  const chat = getChat(input.chatId, input.ownerId);
  if (!chat) return null;
  const key = providerSessionKey(input.execution, input.connectionId);
  const previous = chat.sessionState?.providerSessions?.[key];
  const candidateCursor = input.candidateCursor === null
    ? undefined
    : input.candidateCursor ?? previous?.candidateCursor;
  const next: ProviderSessionBinding = {
    execution: input.execution,
    connectionId: input.connectionId,
    contextOwner: input.contextOwner,
    ...(input.promoteCursor && candidateCursor
      ? { lastKnownGoodCursor: candidateCursor }
      : previous?.lastKnownGoodCursor
        ? { lastKnownGoodCursor: previous.lastKnownGoodCursor }
        : {}),
    ...(!input.promoteCursor && candidateCursor ? { candidateCursor } : {}),
    ...(input.modelId ? { modelId: input.modelId } : previous?.modelId ? { modelId: previous.modelId } : {}),
    ...(input.lastContextTokens !== undefined
      ? { lastContextTokens: input.lastContextTokens }
      : previous?.lastContextTokens !== undefined
        ? { lastContextTokens: previous.lastContextTokens }
        : {}),
    ...(input.lastContextWindow !== undefined
      ? { lastContextWindow: input.lastContextWindow }
      : previous?.lastContextWindow !== undefined
        ? { lastContextWindow: previous.lastContextWindow }
        : {}),
    ...(input.lastCompactionAt
      ? { lastCompactionAt: input.lastCompactionAt }
      : previous?.lastCompactionAt
        ? { lastCompactionAt: previous.lastCompactionAt }
        : {}),
    recoveryGeneration: (previous?.recoveryGeneration || 0) + (input.bumpRecoveryGeneration ? 1 : 0),
    updatedAt: new Date().toISOString(),
  };
  const sessionState = {
    ...(chat.sessionState || {}),
    providerSessions: {
      ...(chat.sessionState?.providerSessions || {}),
      [key]: next,
    },
  };
  updateChat(input.chatId, { sessionState }, input.ownerId);
  return next;
}

export function clearProviderSessionBinding(
  chatId: string,
  ownerId: string | undefined,
  execution: ProviderExecution,
  connectionId: string,
) {
  const chat = getChat(chatId, ownerId);
  if (!chat?.sessionState?.providerSessions) return false;
  const key = providerSessionKey(execution, connectionId);
  if (!(key in chat.sessionState.providerSessions)) return false;
  const providerSessions = { ...chat.sessionState.providerSessions };
  delete providerSessions[key];
  updateChat(chatId, { sessionState: { ...chat.sessionState, providerSessions } }, ownerId);
  return true;
}

/**
 * Revert changes the canonical conversation boundary. A provider-native cursor
 * may still contain turns that Metis just removed, so keeping any continuation
 * binding would silently re-introduce reverted context on the next send.
 * Preserve UI/session state but invalidate every provider continuation.
 */
export function withoutProviderSessionBindings(
  sessionState: Chat["sessionState"] | undefined,
): Chat["sessionState"] | undefined {
  if (!sessionState) return undefined;
  if (!sessionState.providerSessions) return sessionState;
  const next = { ...sessionState };
  delete next.providerSessions;
  return next;
}
