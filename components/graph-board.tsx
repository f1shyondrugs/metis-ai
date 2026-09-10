"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Fullscreen, Minimize2, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { pinchDistance, pinchMidpoint } from "@/lib/notes-gestures";
import {
  defaultGraphWindow,
  panGraphWindow,
  windowToBoundingBox,
  zoomGraphWindow,
  type GraphWindow,
} from "@/lib/graph-view";
import "@/app/jsxgraph.css";
import {
  compileGraphExpression,
  parseGraphDocument,
  serializeGraphDocument,
  type GraphBoardSpec,
  type GraphDocument,
  type GraphElement,
} from "@/lib/graph-spec";

const COLORS = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed"];

type Mode = "board" | "edit" | "code";
type JxgBoard = {
  create: (type: string, parents: unknown[], attrs?: Record<string, unknown>) => JxgObject;
  setBoundingBox: (box: number[], keep?: boolean) => void;
  update: () => void;
  free: () => void;
  resizeContainer: (width: number, height: number) => void;
  getUsrCoordsOfMouse: (event: unknown) => number[];
  suspendUpdate?: () => void;
  unsuspendUpdate?: () => void;
};
type JxgObject = {
  Y?: (...args: number[]) => number;
  X?: () => number;
  on?: (event: string, handler: () => void) => void;
  setAttribute?: (attrs: Record<string, unknown>) => void;
};

function structureKey(spec: GraphBoardSpec) {
  return spec.elements.map((element) => {
    if (element.type === "slider") return `s:${element.name}:${element.min}:${element.max}`;
    if (element.type === "function") return "f";
    if (element.type === "point") return `p:${element.name}`;
    if (element.type === "line") return `l:${element.from}:${element.to}`;
    if (element.type === "circle") return `c:${element.center}`;
    return `t:${element.x}:${element.y}`;
  }).join("|") + `|a:${spec.axis !== false}|g:${spec.grid !== false}`;
}

function sliderElements(spec: GraphBoardSpec) {
  return spec.elements.filter((element): element is Extract<GraphElement, { type: "slider" }> => element.type === "slider");
}

function functionItems(spec: GraphBoardSpec) {
  const named = (spec.title || "").split(/\s*[·•\-|]\s*/).map((part) => part.trim()).filter(Boolean);
  return spec.elements.flatMap((element, index) => {
    if (element.type !== "function") return [];
    const order = spec.elements.slice(0, index).filter((item) => item.type === "function").length;
    return [{
      index,
      fn: element.fn,
      color: element.color || COLORS[order % COLORS.length],
      width: element.width || 2,
      label: named[order] || element.fn,
      hidden: Boolean(element.hidden),
    }];
  });
}

function nextSliderName(elements: GraphElement[]) {
  const used = new Set(elements.flatMap((element) => element.type === "slider" ? [element.name] : []));
  return ["a", "b", "c", "d", "k", "m", "n"].find((name) => !used.has(name)) || `s${used.size + 1}`;
}

function axisStyle(color: string) {
  return {
    strokeColor: color,
    highlight: false,
    withLabel: false,
    ticks: {
      visible: true,
      drawLabels: true,
      insertTicks: true,
      minorTicks: 1,
      majorHeight: 10,
      minorHeight: 4,
      strokeColor: color,
      highlight: false,
      label: { color, fontSize: 11, highlight: false, display: "internal" },
    },
  };
}

function applyDotGrid(surface: HTMLElement, win: GraphWindow) {
  const zoom = Math.min(4, Math.max(0.25, 12 / Math.max(1e-6, win.xmax - win.xmin)));
  const size = 24 * zoom;
  surface.style.backgroundSize = `${size}px ${size}px`;
  const width = surface.clientWidth || 1;
  const height = surface.clientHeight || 1;
  surface.style.backgroundPosition = `${-((win.xmin / (win.xmax - win.xmin)) * width)}px ${((win.ymax / (win.ymax - win.ymin)) * height)}px`;
}

function clampGraphHeight(value: number) {
  return Math.min(960, Math.max(200, Math.round(value)));
}

function measureBoardBox(surface: HTMLElement) {
  const rect = surface.getBoundingClientRect();
  return {
    width: Math.round(rect.width || surface.clientWidth),
    height: Math.round(rect.height || surface.clientHeight),
  };
}

function fitBoard(board: JxgBoard, surface: HTMLElement, host: HTMLElement, win: GraphWindow) {
  const { width, height } = measureBoardBox(surface);
  if (width <= 0 || height <= 0) return;
  host.style.width = "100%";
  host.style.height = "100%";
  board.resizeContainer(width, height);
  board.setBoundingBox(windowToBoundingBox(win), false);
  board.update();
  const svg = host.querySelector("svg");
  if (svg instanceof SVGElement) {
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.style.width = "100%";
    svg.style.height = "100%";
  }
  applyDotGrid(surface, win);
}

export function GraphBoard({
  code,
  language,
}: {
  code: string;
  language?: string;
}) {
  const reactId = useId().replace(/:/g, "");
  const [mode, setMode] = useState<Mode>("board");
  const [fullscreen, setFullscreen] = useState(false);
  const [source, setSource] = useState(code);
  const [draft, setDraft] = useState(code);
  const [error, setError] = useState("");
  const [graph, setGraph] = useState<GraphDocument | null>(null);
  const graphRef = useRef<GraphDocument | null>(null);
  graphRef.current = graph;

  useEffect(() => {
    setSource(code);
    setDraft(code);
  }, [code]);

  useEffect(() => {
    try {
      setGraph(parseGraphDocument(source));
      setError("");
    } catch (cause) {
      setGraph(null);
      setError(cause instanceof Error ? cause.message : "Could not parse graph.");
    }
  }, [source]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const persist = useCallback((next: GraphDocument) => {
    const serialized = serializeGraphDocument(next);
    setGraph(next);
    setSource(serialized);
    setDraft(serialized);
    setError("");
    queueMicrotask(() => {
      rootRef.current?.closest(".editable-markdown")?.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }),
      );
    });
  }, []);

  const applyDraft = useCallback(() => {
    try {
      persist(parseGraphDocument(draft));
      setMode("board");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not apply graph JSON.");
    }
  }, [draft, persist]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const toolbar = (
    <div className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-md border border-border/50 bg-background/90 p-0.5 text-[11px]">
      {(["board", "edit", "code"] as const).map((item) => (
        <button
          key={item}
          type="button"
          className={cn("rounded px-1.5 py-0.5 capitalize", mode === item ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
          onClick={() => setMode(item)}
        >
          {item === "board" ? "Graph" : item === "edit" ? "Edit" : "Code"}
        </button>
      ))}
      <button
        type="button"
        className="rounded p-1 text-muted-foreground hover:text-foreground"
        aria-label={fullscreen ? "Exit fullscreen" : "Open graph fullscreen"}
        title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        onClick={() => setFullscreen((current) => !current)}
      >
        {fullscreen ? <Minimize2 className="size-3.5" /> : <Fullscreen className="size-3.5" />}
      </button>
    </div>
  );

  const body = error && !graph ? (
    <div className="px-3 py-8 pr-28 text-sm text-muted-foreground" data-graph-source={source}>
      {error}. Switch to Code to fix the JSON.
    </div>
  ) : mode === "code" ? (
    <div className="space-y-2 p-3 pr-28">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
        className="min-h-48 w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 font-mono text-xs leading-5"
        aria-label="Graph JSON"
      />
      <div className="flex items-center gap-2">
        <button type="button" className="h-8 rounded-md bg-foreground px-2.5 text-[11px] font-medium text-background" onClick={applyDraft}>
          Apply
        </button>
        {error ? <p className="text-xs text-destructive">{error}</p> : <p className="text-[11px] text-muted-foreground">{language || "graph"}</p>}
      </div>
    </div>
  ) : (
    <div className={cn("flex min-h-0 flex-col", fullscreen && "flex-1")}>
      {(graph?.boards || []).map((board, index) => (
        <InteractiveBoard
          key={`${reactId}-${index}`}
          spec={board}
          boardId={`${reactId}-${index}`}
          tall={fullscreen}
          onChange={(nextBoard) => {
            const current = graphRef.current;
            if (!current) return;
            persist({
              boards: current.boards.map((item, itemIndex) => itemIndex === index ? nextBoard : item),
            });
          }}
        />
      ))}
      {mode === "edit" && graph ? <GraphEditor document={graph} onChange={persist} /> : null}
    </div>
  );

  const card = (
    <div
      ref={rootRef}
      className={cn(
        "group relative my-2 max-w-full overflow-hidden rounded-lg border border-border/40 bg-background [contain:layout_paint_style]",
        fullscreen && "my-0 flex h-full flex-col rounded-none border-0",
      )}
      data-editor-control="graph"
      data-graph-source={source}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {toolbar}
      {body}
    </div>
  );

  if (!fullscreen) return card;
  const overlay = (
    <div className="fixed inset-0 z-[80] bg-background p-[1%]">
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background">
        <div className="min-h-0 flex-1 overflow-hidden [&>div]:my-0 [&>div]:h-full [&>div]:rounded-none [&>div]:border-0">
          {card}
        </div>
      </div>
    </div>
  );
  return typeof window !== "undefined" ? createPortal(overlay, window.document.body) : overlay;
}

function InteractiveBoard({
  spec,
  boardId,
  tall,
  onChange,
}: {
  spec: GraphBoardSpec;
  boardId: string;
  tall?: boolean;
  onChange: (next: GraphBoardSpec) => void;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const boardRef = useRef<JxgBoard | null>(null);
  const curvesRef = useRef<{ elementIndex: number; object: JxgObject; evaluate: (scope: Record<string, number>) => number }[]>([]);
  const sliderValuesRef = useRef<Record<string, number>>({});
  const specRef = useRef(spec);
  const onChangeRef = useRef(onChange);
  const winRef = useRef<GraphWindow>(defaultGraphWindow(spec.bounds));
  const persistTimer = useRef(0);
  const selectedRef = useRef<number | null>(null);
  const hiddenRef = useRef<Set<number>>(new Set());
  const panningRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pinchRef = useRef<{ distance: number; win: GraphWindow } | null>(null);
  const heightDragRef = useRef<{ y: number; height: number } | null>(null);
  const [voidHeight, setVoidHeight] = useState(320);
  const [mountError, setMountError] = useState("");
  const [sliders, setSliders] = useState(() => sliderElements(spec));
  const [hover, setHover] = useState<{ elementIndex: number; fn: string; color: string } | null>(null);
  specRef.current = spec;
  onChangeRef.current = onChange;
  selectedRef.current = hover?.elementIndex ?? null;

  useEffect(() => {
    const next = sliderElements(spec);
    setSliders(next);
    for (const slider of next) sliderValuesRef.current[slider.name] = slider.value;
  }, [spec]);

  const applyWindow = useCallback((win: GraphWindow) => {
    winRef.current = win;
    boardRef.current?.setBoundingBox(windowToBoundingBox(win), false);
    if (surfaceRef.current) applyDotGrid(surfaceRef.current, win);
  }, []);

  const persistSpec = useCallback((next: GraphBoardSpec, immediate = false) => {
    window.clearTimeout(persistTimer.current);
    const write = () => onChangeRef.current(next);
    if (immediate) write();
    else persistTimer.current = window.setTimeout(write, 500);
  }, []);

  const scopeAt = useCallback((x: number) => {
    const scope: Record<string, number> = { x, ...sliderValuesRef.current };
    return scope;
  }, []);

  const paintSelection = useCallback((index: number | null) => {
    const hidden = hiddenRef.current;
    for (const curve of curvesRef.current) {
      const element = specRef.current.elements[curve.elementIndex];
      if (!element || element.type !== "function") continue;
      const off = hidden.has(curve.elementIndex) || Boolean(element.hidden);
      const active = index === curve.elementIndex;
      curve.object.setAttribute?.({
        highlight: false,
        visible: !off,
        strokeWidth: active ? (element.width || 2) + 1.5 : (element.width || 2),
        strokeOpacity: off ? 0 : index == null || active ? 1 : 0.28,
      });
    }
    boardRef.current?.update();
  }, []);

  const replaceCurve = useCallback((elementIndex: number, fn: string) => {
    const board = boardRef.current;
    const entry = curvesRef.current.find((item) => item.elementIndex === elementIndex);
    const element = specRef.current.elements[elementIndex];
    if (!board || !entry || !element || element.type !== "function") return "";
    try {
      const evaluate = compileGraphExpression(fn, Object.keys(sliderValuesRef.current));
      evaluate(scopeAt(0));
      entry.evaluate = evaluate;
      entry.object.Y = (x: number) => evaluate(scopeAt(x));
      board.update();
      return "";
    } catch (cause) {
      return cause instanceof Error ? cause.message : "Invalid function.";
    }
  }, [scopeAt]);

  useEffect(() => {
    const host = hostRef.current;
    const surface = surfaceRef.current;
    if (!host || !surface) return;
    let cancelled = false;
    let board: JxgBoard | null = null;
    let resize: ResizeObserver | null = null;
    let onResize: (() => void) | null = null;

    void (async () => {
      try {
        const mod = await import("jsxgraph") as { default?: { JSXGraph: { initBoard: Function } }; JSXGraph?: { initBoard: Function } };
        const JXG = mod.default || mod;
        if (!JXG.JSXGraph) throw new Error("JSXGraph failed to load.");
        if (cancelled || !hostRef.current) return;
        host.innerHTML = "";
        const boxId = `jxg-${boardId}`;
        host.id = boxId;
        const dark = document.documentElement.classList.contains("dark");
        const axisColor = dark ? "#a1a1aa" : "#52525b";
        const current = specRef.current;
        const win = defaultGraphWindow(current.bounds);
        winRef.current = win;
        const created = JXG.JSXGraph.initBoard(boxId, {
          boundingbox: windowToBoundingBox(win),
          axis: false,
          grid: false,
          showCopyright: false,
          showNavigation: false,
          showInfobox: false,
          keepAspectRatio: false,
          pan: { enabled: false },
          zoom: { enabled: false, wheel: false, pinch: false },
        }) as JxgBoard;
        if (current.axis !== false) {
          created.create("axis", [[0, 0], [1, 0]], axisStyle(axisColor));
          created.create("axis", [[0, 0], [0, 1]], axisStyle(axisColor));
        }
        created.suspendUpdate?.();
        const points: Record<string, JxgObject> = {};
        const sliderNames = sliderElements(current).map((item) => item.name);
        for (const slider of sliderElements(current)) {
          sliderValuesRef.current[slider.name] = slider.value;
        }
        curvesRef.current = [];

        current.elements.forEach((element, elementIndex) => {
          if (element.type === "point") {
            const point = created.create("point", [element.x, element.y], {
              name: element.name,
              color: element.color || COLORS[0],
              fixed: Boolean(element.fixed),
              size: 3,
              showInfobox: false,
              highlight: false,
            });
            points[element.name] = point;
            if (!element.fixed) {
              point.on?.("up", () => {
                const next = specRef.current;
                onChangeRef.current({
                  ...next,
                  elements: next.elements.map((item, index) => item.type === "point" && index === elementIndex
                    ? { ...item, x: Number((point.X?.() || 0).toFixed(4)), y: Number((point.Y?.() || 0).toFixed(4)) }
                    : item),
                });
              });
            }
          }
        });

        current.elements.forEach((element, elementIndex) => {
          if (element.type === "function") {
            const evaluate = compileGraphExpression(element.fn, sliderNames);
            const curve = created.create("functiongraph", [
              (x: number) => evaluate(scopeAt(x)),
            ], {
              strokeColor: element.color || COLORS[elementIndex % COLORS.length],
              strokeWidth: element.width || 2,
              highlight: false,
              withLabel: false,
              fixed: true,
              tabindex: -1,
              visible: !element.hidden,
            });
            curvesRef.current.push({ elementIndex, object: curve, evaluate });
          } else if (element.type === "line") {
            const from = points[element.from];
            const to = points[element.to];
            if (from && to) created.create("line", [from, to], { strokeColor: element.color || axisColor, highlight: false });
          } else if (element.type === "circle") {
            const center = points[element.center];
            if (!center) return;
            const radius = typeof element.radius === "number"
              ? element.radius
              : (() => {
                const evaluate = compileGraphExpression(String(element.radius), sliderNames);
                return () => evaluate(scopeAt(0));
              })();
            created.create("circle", [center, radius], { strokeColor: element.color || axisColor, highlight: false });
          } else if (element.type === "text") {
            created.create("text", [element.x, element.y, element.text], { color: axisColor, fontSize: 13, highlight: false });
          }
        });

        created.unsuspendUpdate?.();
        board = created;
        boardRef.current = created;
        paintSelection(selectedRef.current);
        applyDotGrid(surface, win);
        const syncSize = () => {
          const liveHost = hostRef.current;
          const liveSurface = surfaceRef.current;
          if (!liveHost) return;
          fitBoard(created, liveSurface || surface, liveHost, winRef.current);
        };
        resize = new ResizeObserver(syncSize);
        resize.observe(surface);
        const card = surface.closest("[data-editor-control=graph]");
        if (card instanceof HTMLElement && card !== surface) resize.observe(card);
        if (surface.parentElement && surface.parentElement !== card) resize.observe(surface.parentElement);
        onResize = syncSize;
        window.addEventListener("resize", syncSize);
        window.visualViewport?.addEventListener("resize", syncSize);
        requestAnimationFrame(() => {
          syncSize();
          requestAnimationFrame(syncSize);
        });
        if (!cancelled) setMountError("");
      } catch (cause) {
        if (!cancelled) setMountError(cause instanceof Error ? cause.message : "Could not render graph.");
      }
    })();

    return () => {
      cancelled = true;
      resize?.disconnect();
      if (onResize) {
        window.removeEventListener("resize", onResize);
        window.visualViewport?.removeEventListener("resize", onResize);
      }
      try { board?.free(); } catch { /* board already gone */ }
      if (boardRef.current === board) boardRef.current = null;
    };
  }, [boardId, structureKey(spec), applyWindow, scopeAt, paintSelection]);

  useEffect(() => {
    const surface = surfaceRef.current;
    const board = boardRef.current;
    const host = hostRef.current;
    if (!surface || !host || !board) return;
    fitBoard(board, surface, host, winRef.current);
  }, [tall]);

  useEffect(() => {
    if (!boardRef.current) return;
    const hidden = new Set<number>();
    spec.elements.forEach((element, index) => {
      if (element.type === "function") {
        replaceCurve(index, element.fn);
        if (element.hidden) hidden.add(index);
      }
    });
    hiddenRef.current = hidden;
    paintSelection(selectedRef.current);
  }, [spec, replaceCurve, paintSelection]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const wheelOptions: AddEventListenerOptions = { passive: false };
    const onWheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest("[data-graph-hover], [data-graph-sliders], [data-graph-legend], [data-graph-resize]")) return;
      event.preventDefault();
      const box = surface.getBoundingClientRect();
      applyWindow(zoomGraphWindow(
        winRef.current,
        event.clientX - box.left,
        event.clientY - box.top,
        box.width,
        box.height,
        event.deltaY > 0 ? 1.12 : 0.88,
      ));
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        pinchRef.current = { distance: pinchDistance(event.touches[0], event.touches[1]), win: winRef.current };
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !pinchRef.current) return;
      event.preventDefault();
      const mid = pinchMidpoint(event.touches[0], event.touches[1]);
      const box = surface.getBoundingClientRect();
      const nextDistance = pinchDistance(event.touches[0], event.touches[1]);
      applyWindow(zoomGraphWindow(
        pinchRef.current.win,
        mid.clientX - box.left,
        mid.clientY - box.top,
        box.width,
        box.height,
        pinchRef.current.distance / Math.max(1, nextDistance),
      ));
    };
    const onTouchEnd = () => {
      pinchRef.current = null;
    };
    surface.addEventListener("wheel", onWheel, wheelOptions);
    surface.addEventListener("touchstart", onTouchStart, { passive: true });
    surface.addEventListener("touchmove", onTouchMove, { passive: false });
    surface.addEventListener("touchend", onTouchEnd);
    return () => {
      surface.removeEventListener("wheel", onWheel, wheelOptions);
      surface.removeEventListener("touchstart", onTouchStart);
      surface.removeEventListener("touchmove", onTouchMove);
      surface.removeEventListener("touchend", onTouchEnd);
    };
  }, [applyWindow]);

  function hitFunction(event: unknown) {
    const board = boardRef.current;
    const host = hostRef.current;
    if (!board || !host) return null;
    const coords = board.getUsrCoordsOfMouse(event);
    const x = coords[1];
    const y = coords[2];
    const box = host.getBoundingClientRect();
    const units = (winRef.current.ymax - winRef.current.ymin) / Math.max(1, box.height);
    const tol = 12 * units;
    const hidden = hiddenRef.current;
    for (const curve of curvesRef.current) {
      if (hidden.has(curve.elementIndex)) continue;
      const fy = curve.evaluate(scopeAt(x));
      if (Number.isFinite(fy) && Math.abs(fy - y) < tol) return curve.elementIndex;
    }
    return null;
  }

  function moveTooltip(clientX: number, clientY: number) {
    const surface = surfaceRef.current;
    const tooltip = tooltipRef.current;
    if (!surface || !tooltip) return;
    const box = surface.getBoundingClientRect();
    const left = Math.min(box.width - 16, Math.max(8, clientX - box.left + 12));
    const top = Math.min(box.height - 16, Math.max(8, clientY - box.top - 28));
    tooltip.style.transform = `translate(${left}px, ${top}px)`;
  }

  function hoverFunction(elementIndex: number | null, clientX?: number, clientY?: number) {
    if (elementIndex == null) {
      if (selectedRef.current == null) return;
      selectedRef.current = null;
      setHover(null);
      paintSelection(null);
      return;
    }
    const element = specRef.current.elements[elementIndex];
    if (!element || element.type !== "function") return;
    if (selectedRef.current !== elementIndex) {
      selectedRef.current = elementIndex;
      const order = specRef.current.elements.slice(0, elementIndex).filter((item) => item.type === "function").length;
      setHover({ elementIndex, fn: element.fn, color: element.color || COLORS[order % COLORS.length] });
      paintSelection(elementIndex);
    }
    if (clientX != null && clientY != null) requestAnimationFrame(() => moveTooltip(clientX, clientY));
  }

  function toggleFunction(elementIndex: number) {
    const element = specRef.current.elements[elementIndex];
    if (!element || element.type !== "function") return;
    const hidden = new Set(hiddenRef.current);
    if (hidden.has(elementIndex) || element.hidden) hidden.delete(elementIndex);
    else hidden.add(elementIndex);
    hiddenRef.current = hidden;
    persistSpec({
      ...specRef.current,
      elements: specRef.current.elements.map((item, index) => item.type === "function" && index === elementIndex
        ? { ...item, hidden: hidden.has(elementIndex) }
        : item),
    }, true);
    if (selectedRef.current === elementIndex) {
      selectedRef.current = null;
      setHover(null);
    }
    paintSelection(selectedRef.current);
  }

  function updateSlider(name: string, value: number, persistValue: boolean) {
    sliderValuesRef.current[name] = value;
    setSliders((current) => current.map((item) => item.name === name ? { ...item, value } : item));
    boardRef.current?.update();
    if (!persistValue) return;
    const next = specRef.current;
    onChangeRef.current({
      ...next,
      elements: next.elements.map((item) => item.type === "slider" && item.name === name ? { ...item, value } : item),
    });
  }

  function addElement(element: GraphElement) {
    onChangeRef.current({ ...specRef.current, elements: [...specRef.current.elements, element] });
  }

  const functions = functionItems(spec);

  return (
    <section className={cn("flex min-h-0 flex-col", tall && "h-full")}>
      {functions.length ? (
        <div data-graph-legend="" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pr-28 pt-2">
          {functions.map((item) => {
            const off = item.hidden;
            return (
              <button
                key={item.index}
                type="button"
                aria-pressed={!off}
                aria-label={`${off ? "Show" : "Hide"} ${item.label}`}
                className={cn("flex h-7 items-center gap-1.5 font-mono text-xs", off ? "text-muted-foreground/50" : "text-muted-foreground hover:text-foreground")}
                onClick={() => toggleFunction(item.index)}
              >
                <span className={cn("size-2 shrink-0 rounded-sm", off && "opacity-30") } style={{ backgroundColor: item.color }} aria-hidden="true" />
                <span className={cn("max-w-[12rem] truncate", off && "line-through")}>
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
      ) : spec.title ? (
        <h4 className="px-3 pt-2 text-xs font-medium text-foreground">{spec.title}</h4>
      ) : null}
      <div
        ref={surfaceRef}
        className={cn(
          "graph-void relative min-h-[200px] touch-none overflow-hidden [&_.jxgbox]:!h-full [&_.jxgbox]:!w-full [&_.jxgbox]:!max-w-full [&_.jxgbox]:!border-0 [&_.jxgbox]:!bg-transparent [&_.jxgbox]:outline-none [&_.jxgbox_*]:outline-none [&_.jxgbox:focus]:outline-none [&_.jxgbox_*:focus]:outline-none",
          tall ? "min-h-0 flex-1" : "",
        )}
        style={{
          height: tall ? undefined : voidHeight,
          backgroundColor: "var(--background)",
          backgroundImage: "radial-gradient(circle at 1px 1px, color-mix(in oklch, var(--muted-foreground) 24%, transparent) 1px, transparent 1.2px)",
          backgroundSize: "24px 24px",
        }}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("[data-graph-hover], [data-graph-sliders], [data-graph-legend], [data-graph-resize]")) return;
          if (event.button !== 0) return;
          panningRef.current = { x: event.clientX, y: event.clientY, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (panningRef.current) {
            const box = event.currentTarget.getBoundingClientRect();
            applyWindow(panGraphWindow(
              winRef.current,
              event.clientX - panningRef.current.x,
              event.clientY - panningRef.current.y,
              box.width,
              box.height,
            ));
            panningRef.current = { x: event.clientX, y: event.clientY, moved: true };
            return;
          }
          hoverFunction(hitFunction(event), event.clientX, event.clientY);
        }}
        onPointerLeave={() => hoverFunction(null)}
        onPointerUp={() => {
          panningRef.current = null;
        }}
      >
        <div ref={hostRef} className="absolute inset-0 overflow-hidden" />
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[5] h-12 bg-gradient-to-b from-background to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] h-12 bg-gradient-to-t from-background to-transparent" />
        {hover ? (
          <div
            ref={tooltipRef}
            data-graph-hover=""
            className="pointer-events-none absolute left-0 top-0 z-20 flex items-center gap-1.5 bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground"
          >
            <span className="h-3 w-0.5 shrink-0" style={{ backgroundColor: hover.color }} />
            {hover.fn}
          </div>
        ) : null}
        <div data-graph-sliders="" className="absolute inset-x-0 bottom-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 bg-background/85 px-3 py-1.5">
          {sliders.map((slider) => (
            <label key={slider.name} className="flex min-w-[10rem] flex-1 items-center gap-2 text-xs">
              <span className="w-4 shrink-0 font-mono text-muted-foreground">{slider.name}</span>
              <input
                type="range"
                min={slider.min}
                max={slider.max}
                step={slider.step || 0.05}
                value={slider.value}
                aria-label={`Slider ${slider.name}`}
                className="h-8 min-h-8 flex-1 accent-foreground"
                onChange={(event) => updateSlider(slider.name, Number(event.target.value), false)}
                onPointerUp={(event) => updateSlider(slider.name, Number((event.target as HTMLInputElement).value), true)}
              />
              <input
                type="number"
                min={slider.min}
                max={slider.max}
                step={slider.step || 0.05}
                value={slider.value}
                aria-label={`Value ${slider.name}`}
                className="h-8 w-14 border-0 bg-transparent font-mono text-xs outline-none"
                onChange={(event) => updateSlider(slider.name, Number(event.target.value), false)}
                onBlur={(event) => updateSlider(slider.name, Number(event.target.value), true)}
              />
            </label>
          ))}
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => addElement({ type: "function", fn: "x", color: COLORS[spec.elements.length % COLORS.length] })}
          >
            <Plus className="size-3" /> Function
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => addElement({ type: "slider", name: nextSliderName(spec.elements), min: -5, max: 5, value: 1, step: 0.05 })}
          >
            <Plus className="size-3" /> Slider
          </button>
        </div>
      </div>
      {!tall ? (
        <div
          data-graph-resize=""
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize graph height"
          className="flex h-3 cursor-ns-resize items-center justify-center"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            heightDragRef.current = { y: event.clientY, height: voidHeight };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = heightDragRef.current;
            if (!drag) return;
            setVoidHeight(clampGraphHeight(drag.height + event.clientY - drag.y));
          }}
          onPointerUp={() => {
            heightDragRef.current = null;
          }}
        >
          <span className="h-0.5 w-8 rounded-full bg-border" aria-hidden="true" />
        </div>
      ) : null}
      {mountError ? <p className="px-3 pb-2 text-xs text-destructive">{mountError}</p> : null}
    </section>
  );
}

function GraphEditor({
  document,
  onChange,
}: {
  document: GraphDocument;
  onChange: (next: GraphDocument) => void;
}) {
  function updateBoard(index: number, next: GraphBoardSpec) {
    onChange({ boards: document.boards.map((board, boardIndex) => boardIndex === index ? next : board) });
  }

  return (
    <div data-graph-edit="" className="space-y-4 border-t border-border/40 px-3 py-3 pr-28 text-xs">
      {document.boards.map((board, boardIndex) => (
        <div key={`edit-${boardIndex}`} className="space-y-2">
          <label className="block font-medium">Functions</label>
          <div className="space-y-2">
            {board.elements.map((element, elementIndex) => (
              <div key={`${element.type}-${elementIndex}`} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  {element.type === "function" ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={element.color || COLORS[elementIndex % COLORS.length]}
                        aria-label="Function color"
                        onChange={(event) => updateBoard(boardIndex, {
                          ...board,
                          elements: board.elements.map((item, index) => item.type === "function" && index === elementIndex ? { ...item, color: event.target.value } : item),
                        })}
                        className="h-8 w-8 shrink-0 border-0 bg-transparent p-0"
                      />
                      <input
                        value={element.fn}
                        spellCheck={false}
                        aria-label="Function"
                        onChange={(event) => updateBoard(boardIndex, {
                          ...board,
                          elements: board.elements.map((item, index) => item.type === "function" && index === elementIndex ? { ...item, fn: event.target.value } : item),
                        })}
                        className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono"
                      />
                    </div>
                  ) : element.type === "slider" ? (
                    <div className="grid grid-cols-4 gap-1.5">
                      <input value={element.name} aria-label="Slider name" onChange={(event) => updateBoard(boardIndex, { ...board, elements: board.elements.map((item, index) => item.type === "slider" && index === elementIndex ? { ...item, name: event.target.value } : item) })} className="col-span-4 h-8 rounded-md border border-input bg-background px-2" />
                      {(["min", "max", "value"] as const).map((key) => (
                        <label key={key} className="text-muted-foreground">
                          {key}
                          <input type="number" step="0.1" value={element[key]} onChange={(event) => updateBoard(boardIndex, { ...board, elements: board.elements.map((item, index) => item.type === "slider" && index === elementIndex ? { ...item, [key]: Number(event.target.value) } : item) })} className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-foreground" />
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="pt-1.5 text-muted-foreground">{element.type}</p>
                  )}
                </div>
                <button type="button" className="mt-1 text-muted-foreground hover:text-destructive" aria-label="Remove element" onClick={() => updateBoard(boardIndex, { ...board, elements: board.elements.filter((_, index) => index !== elementIndex) })}>
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="inline-flex h-8 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => updateBoard(boardIndex, { ...board, elements: [...board.elements, { type: "function", fn: "x", color: COLORS[board.elements.length % COLORS.length] }] })}>
              <Plus className="size-3" /> Function
            </button>
            <button type="button" className="inline-flex h-8 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => updateBoard(boardIndex, { ...board, elements: [...board.elements, { type: "slider", name: nextSliderName(board.elements), min: -5, max: 5, value: 1, step: 0.05 }] })}>
              <Plus className="size-3" /> Slider
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
