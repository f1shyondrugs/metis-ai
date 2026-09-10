"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Fullscreen, Minimize2 } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import {
  parseChartDocument,
  serializeChartDocument,
  type ChartDocument,
  type ChartSeries,
  type ChartSpec,
  type ChartType,
} from "@/lib/chart-spec";

const COLORS = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed"];
type Mode = "board" | "edit" | "code";

function clampChartHeight(value: number) {
  return Math.min(960, Math.max(200, Math.round(value)));
}

function normalizedSeries(spec: ChartSpec): ChartSeries[] {
  if (spec.series?.length) return spec.series;
  if (spec.values) return [{ name: spec.title || "Data", values: spec.values }];
  return [];
}

function labelsFor(spec: ChartSpec) {
  const listed = spec.labels?.length ? spec.labels : (spec.x || []).map(String);
  if (listed.length) return listed;
  const length = Math.max(
    spec.values?.length || 0,
    ...normalizedSeries(spec).map((series) => series.values?.length || 0),
    0,
  );
  return Array.from({ length }, (_, index) => String(index + 1));
}

function seriesColor(series: ChartSeries, index: number) {
  return series.color || COLORS[index % COLORS.length];
}

function chartRows(spec: ChartSpec) {
  return labelsFor(spec).map((label, index) => {
    const row: Record<string, string | number> = { label };
    for (const series of normalizedSeries(spec)) {
      row[series.name] = series.values?.[index] ?? 0;
    }
    return row;
  });
}

function ChartHover({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="flex flex-col gap-0.5 bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground">
      {label !== undefined && label !== "" ? <span className="text-muted-foreground">{label}</span> : null}
      {payload.map((item) => (
        <span key={item.name} className="flex items-center gap-1.5">
          <span className="h-3 w-0.5 shrink-0" style={{ backgroundColor: item.color }} aria-hidden="true" />
          {item.name} {item.value}
        </span>
      ))}
    </div>
  );
}

const axisColor = "var(--muted-foreground)";
const axisTick = { fill: axisColor, fontSize: 11 };
const plotMargin = { top: 18, right: 24, bottom: 4, left: 0 };

function ChartPlot({ spec, hidden }: { spec: ChartSpec; hidden: Set<string> }) {
  const allSeries = normalizedSeries(spec);
  const visible = allSeries.filter((series) => !hidden.has(series.name));
  const data = chartRows(spec);

  if (spec.type === "pie" || spec.type === "donut") {
    const first = allSeries[0];
    const pieData = labelsFor(spec)
      .map((name, index) => ({ name, value: first?.values?.[index] ?? 0 }))
      .filter((item) => !hidden.has(item.name));
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={pieData}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius="68%"
            innerRadius={spec.type === "donut" ? "42%" : 0}
            paddingAngle={1}
            isAnimationActive={false}
            stroke="var(--background)"
          >
            {pieData.map((item, index) => (
              <Cell key={item.name} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip content={<ChartHover />} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (spec.type === "scatter") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={plotMargin}>
          <XAxis dataKey="x" type="number" stroke={axisColor} tick={axisTick} tickLine={false} axisLine={{ stroke: axisColor }} />
          <YAxis dataKey="y" type="number" stroke={axisColor} tick={axisTick} tickLine={false} axisLine={{ stroke: axisColor }} />
          <Tooltip cursor={false} content={<ChartHover />} />
          {visible.map((series, index) => (
            <Scatter
              key={series.name}
              name={series.name}
              data={(series.points || (series.values || []).map((value, point) => [point, value] as [number, number])).map(([x, y]) => ({ x, y }))}
              fill={seriesColor(series, index)}
              isAnimationActive={false}
            />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    );
  }

  const Chart = spec.type === "bar" ? BarChart : spec.type === "area" ? AreaChart : LineChart;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <Chart data={data} margin={plotMargin}>
        <XAxis dataKey="label" stroke={axisColor} tick={axisTick} tickLine={false} axisLine={{ stroke: axisColor }} />
        <YAxis stroke={axisColor} tick={axisTick} tickLine={false} axisLine={{ stroke: axisColor }} />
        <Tooltip content={<ChartHover />} />
        {visible.map((series) => {
          const index = allSeries.indexOf(series);
          const color = seriesColor(series, index);
          if (spec.type === "bar") {
            return <Bar key={series.name} dataKey={series.name} fill={color} stackId={spec.stacked ? "stack" : undefined} isAnimationActive={false} />;
          }
          if (spec.type === "area") {
            return <Area key={series.name} dataKey={series.name} type="monotone" stroke={color} fill={color} fillOpacity={0.18} stackId={spec.stacked ? "stack" : undefined} isAnimationActive={false} />;
          }
          return <Line key={series.name} dataKey={series.name} type="monotone" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />;
        })}
      </Chart>
    </ResponsiveContainer>
  );
}

function ChartEditor({
  spec,
  onChange,
}: {
  spec: ChartSpec;
  onChange: (next: ChartSpec) => void;
}) {
  const series = normalizedSeries(spec);
  const updateSeries = (index: number, patch: Partial<ChartSeries>) => {
    onChange({
      ...spec,
      series: series.map((item, seriesIndex) => seriesIndex === index ? { ...item, ...patch } : item),
    });
  };
  return (
    <div data-chart-edit className="space-y-2 border-t border-border/40 px-3 py-3 pr-28 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Chart type"
          value={spec.type}
          onChange={(event) => onChange({ ...spec, type: event.target.value as ChartType })}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          {(["bar", "line", "area", "pie", "donut", "scatter"] as const).map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <input type="checkbox" checked={Boolean(spec.stacked)} onChange={(event) => onChange({ ...spec, stacked: event.target.checked })} />
          Stacked
        </label>
      </div>
      <label className="block">
        <span className="font-medium">Labels</span>
        <input
          value={labelsFor(spec).join(", ")}
          onChange={(event) => onChange({ ...spec, labels: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })}
          className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-xs"
        />
      </label>
      <div className="space-y-2">
        {series.map((item, index) => (
          <div key={`${item.name}-${index}`} className="flex items-center gap-2">
            <input
              type="color"
              aria-label={`Series ${index + 1} color`}
              value={item.color || seriesColor(item, index)}
              onChange={(event) => updateSeries(index, { color: event.target.value })}
              className="h-8 w-8 shrink-0 border-0 bg-transparent p-0"
            />
            <input
              aria-label={`Series ${index + 1} name`}
              value={item.name}
              onChange={(event) => updateSeries(index, { name: event.target.value })}
              className="h-8 w-28 rounded-md border border-input bg-background px-2 text-xs"
            />
            <input
              aria-label={`Series ${index + 1} values`}
              value={(item.values || []).join(", ")}
              onChange={(event) => updateSeries(index, {
                values: event.target.value.split(",").map((part) => Number(part.trim())).filter((value) => Number.isFinite(value)),
              })}
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function InteractiveChart({
  spec,
  tall,
  hidden,
  onToggle,
  height,
}: {
  spec: ChartSpec;
  tall?: boolean;
  hidden: Set<string>;
  onToggle: (name: string) => void;
  height: number;
}) {
  const series = normalizedSeries(spec);
  const pieLegend = spec.type === "pie" || spec.type === "donut";
  const legendItems = pieLegend
    ? labelsFor(spec).map((name, index) => ({ name, color: COLORS[index % COLORS.length] }))
    : series.map((item, index) => ({ name: item.name, color: seriesColor(item, index) }));

  return (
    <section className={cn("flex min-h-0 flex-col", tall && "h-full")}>
      {legendItems.length ? (
        <div data-chart-legend className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pr-28 pt-2">
          {legendItems.map((item) => {
            const off = hidden.has(item.name);
            return (
              <button
                key={item.name}
                type="button"
                aria-pressed={!off}
                aria-label={`${off ? "Show" : "Hide"} ${item.name}`}
                className={cn("flex h-7 items-center gap-1.5 font-mono text-xs", off ? "text-muted-foreground/50" : "text-muted-foreground hover:text-foreground")}
                onClick={() => onToggle(item.name)}
              >
                <span className={cn("size-2 shrink-0 rounded-sm", off && "opacity-30")} style={{ backgroundColor: item.color }} aria-hidden="true" />
                <span className={cn("max-w-[12rem] truncate", off && "line-through")}>{item.name}</span>
              </button>
            );
          })}
        </div>
      ) : spec.title ? (
        <h4 className="px-3 pt-2 text-xs font-medium text-foreground">{spec.title}</h4>
      ) : null}
      <div
        data-chart-renderer
        className={cn("relative min-h-[200px] overflow-hidden", tall ? "min-h-0 flex-1" : "")}
        style={{
          height: tall ? undefined : height,
          backgroundColor: "var(--background)",
          backgroundImage: "radial-gradient(circle at 1px 1px, color-mix(in oklch, var(--muted-foreground) 24%, transparent) 1px, transparent 1.2px)",
          backgroundSize: "24px 24px",
        }}
      >
        <div className="absolute inset-0 pb-2 pl-1 pr-4 pt-4">
          <ChartPlot spec={spec} hidden={hidden} />
        </div>
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[5] h-12 bg-gradient-to-b from-background to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] h-12 bg-gradient-to-t from-background to-transparent" />
      </div>
    </section>
  );
}

export function ChartBoard({
  code,
  language,
}: {
  code: string;
  language?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<Mode>("board");
  const [fullscreen, setFullscreen] = useState(false);
  const [source, setSource] = useState(code);
  const [draft, setDraft] = useState(code);
  const [document, setDocument] = useState<ChartDocument | null>(null);
  const [error, setError] = useState("");
  const [height, setHeight] = useState(320);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const heightDrag = useRef<{ y: number; height: number } | null>(null);

  useEffect(() => {
    setSource(code);
    setDraft(code);
  }, [code]);

  useEffect(() => {
    try {
      setDocument(parseChartDocument(source));
      setError("");
    } catch (cause) {
      setDocument(null);
      setError(cause instanceof Error ? cause.message : "Could not parse chart.");
    }
  }, [source]);

  const persist = useCallback((next: ChartDocument) => {
    const serialized = serializeChartDocument(next);
    setDocument(next);
    setSource(serialized);
    setDraft(serialized);
    setError("");
    queueMicrotask(() => {
      rootRef.current?.closest(".editable-markdown")?.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }),
      );
    });
  }, []);

  const applyDraft = () => {
    try {
      persist(parseChartDocument(draft));
      setMode("board");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not apply chart JSON.");
    }
  };

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const toggleSeries = (name: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const charts = document?.charts || [];
  const toolbar = (
    <div className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-md border border-border/50 bg-background/90 p-0.5 text-[11px]">
      {(["board", "edit", "code"] as const).map((item) => (
        <button
          key={item}
          type="button"
          className={cn("rounded px-1.5 py-0.5 capitalize", mode === item ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
          onClick={() => setMode(item)}
        >
          {item === "board" ? "Chart" : item === "edit" ? "Edit" : "Code"}
        </button>
      ))}
      <button
        type="button"
        className="rounded p-1 text-muted-foreground hover:text-foreground"
        aria-label={fullscreen ? "Exit fullscreen" : "Open chart fullscreen"}
        title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        onClick={() => setFullscreen((current) => !current)}
      >
        {fullscreen ? <Minimize2 className="size-3.5" /> : <Fullscreen className="size-3.5" />}
      </button>
    </div>
  );

  const body = error && !document ? (
    <div className="px-3 py-8 pr-28 text-sm text-muted-foreground">
      {error}. Switch to Code to fix the JSON.
    </div>
  ) : mode === "code" ? (
    <div className="space-y-2 p-3 pr-28">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
        aria-label="Chart JSON"
        className="min-h-48 w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 font-mono text-xs leading-5"
      />
      <div className="flex items-center gap-2">
        <button type="button" className="h-8 rounded-md bg-foreground px-2.5 text-[11px] font-medium text-background" onClick={applyDraft}>Apply</button>
        {error ? <p className="text-xs text-destructive">{error}</p> : <p className="text-[11px] text-muted-foreground">{language || "chart"}</p>}
      </div>
    </div>
  ) : (
    <div className={cn("flex min-h-0 flex-col", fullscreen && "flex-1")}>
      {charts.map((item, index) => (
        <InteractiveChart
          key={`${item.type}-${item.title || index}`}
          spec={item}
          tall={fullscreen}
          hidden={hidden}
          onToggle={toggleSeries}
          height={height}
        />
      ))}
      {mode === "edit" ? charts.map((spec, index) => (
        <ChartEditor
          key={`edit-${index}`}
          spec={spec}
          onChange={(next) => {
            if (!document) return;
            persist({ charts: document.charts.map((item, itemIndex) => itemIndex === index ? next : item) });
          }}
        />
      )) : null}
      {!fullscreen ? (
        <div
          data-chart-resize
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize chart height"
          className="flex h-3 cursor-ns-resize items-center justify-center"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            heightDrag.current = { y: event.clientY, height };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = heightDrag.current;
            if (!drag) return;
            setHeight(clampChartHeight(drag.height + event.clientY - drag.y));
          }}
          onPointerUp={() => {
            heightDrag.current = null;
          }}
        >
          <span className="h-0.5 w-8 rounded-full bg-border" aria-hidden="true" />
        </div>
      ) : null}
    </div>
  );

  const card = (
    <div
      ref={rootRef}
      className={cn(
        "group relative my-2 max-w-full overflow-hidden rounded-lg border border-border/40 bg-background [contain:layout_paint_style]",
        fullscreen && "my-0 flex h-full flex-col rounded-none border-0",
      )}
      data-editor-control="chart"
      data-chart-source={source}
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
