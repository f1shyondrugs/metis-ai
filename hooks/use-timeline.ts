"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { MetisRuntimeEvent } from "@/lib/runtime/events";
import type { TimelineState, TimelineItem } from "@/lib/timeline/reducer";
import { initialTimelineState, reduceTimelineBatch } from "@/lib/timeline/reducer";

interface UseTimelineOptions {
  chatId: string;
  initialState?: TimelineState;
  batchWindowMs?: number;
  maxItems?: number;
}

interface UseTimelineReturn {
  state: TimelineState;
  items: TimelineItem[];
  subscribe: (events: Array<{ event: MetisRuntimeEvent; sequence: number }>) => void;
  replay: (afterSequence: number) => void;
  clear: () => void;
}

function createTimelineStore(initialState: TimelineState) {
  let state = initialState;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initialTimelineState,
    subscribe: (callback: () => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    addEvents(events: Array<{ event: MetisRuntimeEvent; sequence: number }>) {
      if (!events.length) return;
      state = reduceTimelineBatch(state, events);
      emit();
    },
    clear() {
      state = { ...initialTimelineState, pendingDeltas: new Map(), pendingTools: new Map() };
      emit();
    },
  };
}

export function useTimeline({ chatId, initialState, maxItems = 500 }: UseTimelineOptions): UseTimelineReturn {
  const holder = useRef<{ chatId: string; store: ReturnType<typeof createTimelineStore> } | null>(null);
  if (!holder.current || holder.current.chatId !== chatId) {
    holder.current = { chatId, store: createTimelineStore(initialState || initialTimelineState) };
  }
  const store = holder.current.store;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);

  useEffect(() => {
    if (!chatId) return;
    let source: EventSource | null = null;
    let stopped = false;
    const open = () => {
      if (stopped) return;
      const after = store.getSnapshot().lastEventSequence;
      source = new EventSource(`/api/runtime/events?chatId=${encodeURIComponent(chatId)}&after=${after}`);
      source.addEventListener("runtime", (raw) => {
        const message = raw as MessageEvent<string>;
        try {
          const event = JSON.parse(message.data) as MetisRuntimeEvent;
          const sequence = Number(message.lastEventId || 0);
          if (!Number.isFinite(sequence) || sequence <= store.getSnapshot().lastEventSequence) return;
          store.addEvents([{ event, sequence }]);
        } catch {
          // A malformed transport event must not poison the timeline store.
        }
      });
    };
    open();
    return () => {
      stopped = true;
      source?.close();
      source = null;
    };
  }, [chatId, store]);

  const subscribe = useCallback(
    (events: Array<{ event: MetisRuntimeEvent; sequence: number }>) => store.addEvents(events),
    [store],
  );
  const replay = useCallback((afterSequence: number) => {
    // Reconnect semantics are cursor-based. Consumers can move the local cursor
    // backward explicitly by clearing and letting SSE replay durable run_events.
    if (afterSequence <= 0) store.clear();
  }, [store]);
  const clear = useCallback(() => store.clear(), [store]);

  return { state, items: state.items.slice(-maxItems), subscribe, replay, clear };
}

export function useTimelineSelector<T>(state: TimelineState, selector: (state: TimelineState) => T): T {
  return selector(state);
}
