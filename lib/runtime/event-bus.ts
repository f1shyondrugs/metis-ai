import type { MetisRuntimeEvent } from "./events";

export const RUNTIME_EVENT_REPLAY_LIMIT = 2_000;

export interface RuntimeEventSubscription {
  unsubscribe: () => void;
}

export interface RuntimeReplayEvent {
  event: MetisRuntimeEvent;
  sequence: number;
}

type Listener = (event: RuntimeReplayEvent) => void;

/**
 * In-memory subscribable bus for canonical runtime events. This is the WS3
 * transport seam only: the orchestrator will publish adapter events here and
 * persistence/durable recovery can later replace the replay map without a
 * route or UI change.
 */
class RuntimeEventBus {
  private readonly chats = new Map<string, {
    sequence: number;
    replay: Array<RuntimeReplayEvent>;
    listeners: Set<Listener>;
  }>();

  public publish(chatId: string, event: MetisRuntimeEvent): RuntimeReplayEvent {
    const key = this.chatKey(chatId);
    let chat = this.chats.get(key);
    if (!chat) {
      chat = { sequence: 0, replay: [], listeners: new Set() };
      this.chats.set(key, chat);
    }

    if (event.chatId !== chatId) {
      throw new Error("Runtime event chatId does not match the publication channel");
    }

    chat.sequence += 1;
    const replayEvent: RuntimeReplayEvent = { sequence: chat.sequence, event };
    chat.replay.push(replayEvent);
    if (chat.replay.length > RUNTIME_EVENT_REPLAY_LIMIT) {
      chat.replay.splice(0, chat.replay.length - RUNTIME_EVENT_REPLAY_LIMIT);
    }
    for (const listener of chat.listeners) listener(replayEvent);
    return replayEvent;
  }

  public subscribe(
    chatId: string,
    listener: Listener,
  ): RuntimeEventSubscription {
    const key = this.chatKey(chatId);
    let chat = this.chats.get(key);
    if (!chat) {
      chat = { sequence: 0, replay: [], listeners: new Set() };
      this.chats.set(key, chat);
    }
    chat.listeners.add(listener);
    return {
      unsubscribe: () => {
        chat?.listeners.delete(listener);
      },
    };
  }

  public replay(chatId: string, afterSequence = 0): RuntimeReplayEvent[] {
    const chat = this.chats.get(this.chatKey(chatId));
    if (!chat) return [];
    const cursor = Number.isFinite(afterSequence) ? Math.max(0, Math.floor(afterSequence)) : 0;
    const first = chat.replay.findIndex((entry) => entry.sequence > cursor);
    return first === -1 ? [] : chat.replay.slice(first);
  }

  public activeChats(): string[] {
    return [...this.chats.keys()].filter((chatId) => {
      const chat = this.chats.get(chatId);
      return Boolean(chat && (chat.listeners.size > 0 || chat.replay.length > 0));
    });
  }

  public clear(chatId: string): void {
    const chat = this.chats.get(this.chatKey(chatId));
    if (chat) chat.replay = [];
  }

  public reset(): void {
    this.chats.clear();
  }

  private chatKey(chatId: string): string {
    const key = chatId.trim();
    if (!key) throw new Error("chatId is required");
    return key;
  }
}

export const runtimeEventBus = new RuntimeEventBus();
