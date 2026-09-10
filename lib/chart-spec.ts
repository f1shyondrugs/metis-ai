export const CHART_LANGUAGES = new Set(["chart", "charts"]);

export type ChartType = "bar" | "line" | "area" | "pie" | "donut" | "scatter";

export type ChartSeries = {
  name: string;
  values?: number[];
  points?: [number, number][];
  color?: string;
};

export type ChartSpec = {
  title?: string;
  type: ChartType;
  x?: Array<string | number>;
  labels?: string[];
  series?: ChartSeries[];
  values?: number[];
  stacked?: boolean;
  legend?: boolean;
  xLabel?: string;
  yLabel?: string;
};

export type ChartDocument = {
  charts: ChartSpec[];
};

const CHART_TYPES = new Set<ChartType>(["bar", "line", "area", "pie", "donut", "scatter"]);

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function asFiniteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error("Expected a finite number.");
}

function asString(value: unknown, fallback?: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (fallback !== undefined) return fallback;
  throw new Error("Expected a string.");
}

function parseNumberList(value: unknown, field: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map(asFiniteNumber);
}

function parseLabels(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Labels must be an array.");
  return value.map((label) => asString(label));
}

function parseX(value: unknown): Array<string | number> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("X must be an array.");
  return value.map((entry) => typeof entry === "string" ? asString(entry) : asFiniteNumber(entry));
}

function parsePoints(value: unknown): [number, number][] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Points must be an array.");
  return value.map((point) => {
    if (!Array.isArray(point) || point.length !== 2) throw new Error("Each point must be an [x, y] pair.");
    return [asFiniteNumber(point[0]), asFiniteNumber(point[1])] as [number, number];
  });
}

function parseSeries(raw: unknown, index: number): ChartSeries {
  const item = asRecord(raw);
  if (!item) throw new Error(`Series ${index + 1} is not an object.`);
  const series: ChartSeries = { name: asString(item.name, `Series ${index + 1}`) };
  const values = parseNumberList(item.values, "Series values");
  const points = parsePoints(item.points);
  if (values !== undefined) series.values = values;
  if (points !== undefined) series.points = points;
  if (item.color !== undefined) series.color = asString(item.color);
  if (series.values === undefined && series.points === undefined) {
    throw new Error(`Series ${index + 1} needs values or points.`);
  }
  return series;
}

function parseData(value: unknown): ChartSeries[] {
  if (!Array.isArray(value) || !value.length) throw new Error("Data must be a non-empty array.");
  const points = value.map((entry) => {
    const item = asRecord(entry);
    if (!item) throw new Error("Each data point must be an object.");
    return [asFiniteNumber(item.x), asFiniteNumber(item.y)] as [number, number];
  });
  return [{ name: "Data", points }];
}

function parseChart(raw: unknown): ChartSpec {
  const item = asRecord(raw);
  if (!item) throw new Error("Chart must be an object.");
  const rawType = item.type ?? item.kind;
  const type = asString(rawType).toLowerCase() as ChartType;
  if (!CHART_TYPES.has(type)) throw new Error(`Unsupported chart type: ${type}`);

  const chart: ChartSpec = { type };
  if (item.title !== undefined) chart.title = asString(item.title);
  const x = parseX(item.x ?? item.labels);
  if (x !== undefined) chart.x = x;
  const labels = parseLabels(item.labels);
  if (labels !== undefined) chart.labels = labels;
  const values = parseNumberList(item.values, "Values");
  if (values !== undefined) chart.values = values;
  if (Array.isArray(item.series)) chart.series = item.series.map(parseSeries);
  else if (item.series !== undefined) throw new Error("Series must be an array.");
  else if (item.data !== undefined) chart.series = parseData(item.data);
  if (item.stacked !== undefined) chart.stacked = Boolean(item.stacked);
  if (item.legend !== undefined) chart.legend = Boolean(item.legend);
  if (item.xLabel !== undefined) chart.xLabel = asString(item.xLabel);
  if (item.yLabel !== undefined) chart.yLabel = asString(item.yLabel);
  return chart;
}

function jsonSource(source: string): string {
  const trimmed = source.trim();
  const fenced = trimmed.match(/^```(?:json|chart|charts)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parsedJson(source: string): unknown {
  const trimmed = jsonSource(source);
  if (!trimmed) throw new Error("Chart source is empty.");
  return JSON.parse(trimmed) as unknown;
}

function hasChartPayload(item: RecordValue): boolean {
  return item.series !== undefined || item.values !== undefined || item.data !== undefined;
}

function isGraphBoardLike(item: RecordValue): boolean {
  if (item.fn !== undefined) return true;
  if (Array.isArray(item.elements) && item.elements.some((element) => {
    const record = asRecord(element);
    const type = record?.type ?? record?.kind;
    return type === "function" || type === "slider";
  })) return true;
  return item.bounds !== undefined && !hasChartPayload(item);
}

export function isChartSource(language: string | undefined, code: string) {
  const lang = (language || "").toLowerCase();
  if (CHART_LANGUAGES.has(lang)) return true;
  try {
    const parsed = parsedJson(code);
    if (Array.isArray(parsed)) return parsed.length > 0 && parsed.every((item) => {
      const record = asRecord(item);
      return record !== null && !isGraphBoardLike(record) && parseChart(item) !== undefined;
    });
    const record = asRecord(parsed);
    if (!record || isGraphBoardLike(record)) return false;
    if (Array.isArray(record.charts)) return record.charts.length > 0 && record.charts.every((chart) => parseChart(chart) !== undefined);
    return record.type !== undefined || record.kind !== undefined
      ? hasChartPayload(record) && parseChart(record) !== undefined
      : false;
  } catch {
    return false;
  }
}

export function parseChartDocument(source: string): ChartDocument {
  const parsed = parsedJson(source);
  if (Array.isArray(parsed)) {
    if (!parsed.length) throw new Error("Chart list is empty.");
    return { charts: parsed.map(parseChart) };
  }
  const record = asRecord(parsed);
  if (!record) throw new Error("Chart source must be a JSON object or array.");
  if (Array.isArray(record.charts)) {
    if (!record.charts.length) throw new Error("Chart document has no charts.");
    return { charts: record.charts.map(parseChart) };
  }
  return { charts: [parseChart(record)] };
}

export function serializeChartDocument(document: ChartDocument) {
  if (!document.charts.length) throw new Error("Chart document has no charts.");
  const payload = document.charts.length === 1 ? document.charts[0] : { charts: document.charts };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function defaultChartDocument(): ChartDocument {
  return {
    charts: [{
      title: "Umsatz",
      type: "bar",
      x: ["Jan", "Feb", "Mar"],
      series: [{ name: "Umsatz", values: [120, 180, 150] }],
    }],
  };
}
