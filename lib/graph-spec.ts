export const GRAPH_LANGUAGES = new Set(["graph", "jsxgraph", "geogebra", "plot"]);

const SAFE_EXPR = /^[0-9A-Za-z_+\-*/%.,() \t^]+$/;
const MATH_FNS = new Set([
  "sin", "cos", "tan", "asin", "acos", "atan", "abs", "sqrt",
  "log", "ln", "exp", "min", "max", "pow", "floor", "ceil", "round", "sign",
]);
const MATH_CONST = new Set(["pi", "e"]);

export type GraphElement =
  | { type: "function"; id?: string; fn: string; color?: string; width?: number; hidden?: boolean }
  | { type: "slider"; name: string; min: number; max: number; value: number; step?: number }
  | { type: "point"; name: string; x: number; y: number; color?: string; fixed?: boolean }
  | { type: "line"; from: string; to: string; color?: string }
  | { type: "circle"; center: string; radius: number | string; color?: string }
  | { type: "text"; x: number; y: number; text: string };

export type GraphBoardSpec = {
  title?: string;
  bounds?: [number, number, number, number];
  axis?: boolean;
  grid?: boolean;
  elements: GraphElement[];
};

export type GraphDocument = {
  boards: GraphBoardSpec[];
};

export function isGraphSource(language: string | undefined, code: string) {
  const lang = (language || "").toLowerCase();
  if (GRAPH_LANGUAGES.has(lang)) return true;
  const trimmed = code.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    parseGraphDocument(trimmed);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNumber(value: unknown, fallback?: number) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (fallback !== undefined) return fallback;
  throw new Error("Expected a number.");
}

function asString(value: unknown, fallback?: string) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (fallback !== undefined) return fallback;
  throw new Error("Expected a string.");
}

function parseBounds(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const bounds = value.map((item) => asNumber(item)) as [number, number, number, number];
  if (bounds[0] === bounds[1] || bounds[2] === bounds[3]) throw new Error("Graph bounds must span a range.");
  return bounds;
}

function parseElement(raw: unknown, index: number): GraphElement {
  const item = asRecord(raw);
  if (!item) throw new Error(`Element ${index + 1} is not an object.`);
  const type = asString(item.type || item.kind, "function").toLowerCase();
  if (type === "function" || type === "functiongraph" || type === "plot") {
    return {
      type: "function",
      id: typeof item.id === "string" ? item.id : undefined,
      fn: asString(item.fn || item.f || item.formula),
      color: typeof item.color === "string" ? item.color : undefined,
      width: typeof item.width === "number" ? item.width : undefined,
      hidden: item.hidden === true || item.visible === false,
    };
  }
  if (type === "slider") {
    const min = asNumber(item.min, -5);
    const max = asNumber(item.max, 5);
    return {
      type: "slider",
      name: asString(item.name, `s${index + 1}`),
      min,
      max: max === min ? min + 1 : max,
      value: asNumber(item.value, (min + max) / 2),
      step: typeof item.step === "number" ? item.step : undefined,
    };
  }
  if (type === "point") {
    return {
      type: "point",
      name: asString(item.name, `P${index + 1}`),
      x: asNumber(item.x, 0),
      y: asNumber(item.y, 0),
      color: typeof item.color === "string" ? item.color : undefined,
      fixed: Boolean(item.fixed),
    };
  }
  if (type === "line") {
    return {
      type: "line",
      from: asString(item.from || item.a),
      to: asString(item.to || item.b),
      color: typeof item.color === "string" ? item.color : undefined,
    };
  }
  if (type === "circle") {
    return {
      type: "circle",
      center: asString(item.center || item.from),
      radius: typeof item.radius === "string" ? item.radius : asNumber(item.radius, 1),
      color: typeof item.color === "string" ? item.color : undefined,
    };
  }
  if (type === "text" || type === "label") {
    return {
      type: "text",
      x: asNumber(item.x, 0),
      y: asNumber(item.y, 0),
      text: asString(item.text || item.label, ""),
    };
  }
  throw new Error(`Unsupported graph element type: ${type}`);
}

function parseBoard(raw: unknown): GraphBoardSpec {
  const item = asRecord(raw);
  if (!item) throw new Error("Board must be an object.");
  const functions = Array.isArray(item.functions)
    ? item.functions.map((fn, index) => parseElement({ type: "function", fn }, index))
    : [];
  const listed = Array.isArray(item.elements) ? item.elements.map(parseElement) : [];
  if (typeof item.fn === "string" && item.fn.trim()) {
    listed.unshift({ type: "function", fn: item.fn.trim() });
  }
  const elements = [...functions, ...listed];
  if (!elements.length) throw new Error("A graph board needs at least one element.");
  return {
    title: typeof item.title === "string" ? item.title.trim() || undefined : undefined,
    bounds: parseBounds(item.bounds),
    axis: item.axis === undefined ? true : Boolean(item.axis),
    grid: item.grid === undefined ? true : Boolean(item.grid),
    elements,
  };
}

export function parseGraphDocument(source: string): GraphDocument {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("Graph source is empty.");
  const parsed = JSON.parse(trimmed) as unknown;
  if (Array.isArray(parsed)) {
    const boards = parsed.map(parseBoard);
    if (!boards.length) throw new Error("Graph list is empty.");
    return { boards };
  }
  const record = asRecord(parsed);
  if (!record) throw new Error("Graph source must be a JSON object or array.");
  if (Array.isArray(record.boards)) {
    const boards = record.boards.map(parseBoard);
    if (!boards.length) throw new Error("Graph document has no boards.");
    return { boards };
  }
  return { boards: [parseBoard(record)] };
}

export function serializeGraphDocument(document: GraphDocument) {
  const payload = document.boards.length === 1
    ? document.boards[0]
    : { boards: document.boards };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function defaultGraphDocument(): GraphDocument {
  return {
    boards: [{
      title: "Graph",
      bounds: [-6, 6, -4, 4],
      axis: true,
      grid: true,
      elements: [{ type: "function", fn: "sin(x)", color: "#2563eb" }],
    }],
  };
}

export function compileGraphExpression(expr: string, names: string[] = []) {
  const source = expr.trim().replace(/\^/g, "**");
  if (!source) throw new Error("Function is empty.");
  if (!SAFE_EXPR.test(source)) throw new Error(`Unsafe graph expression: ${expr}`);
  const allowed = new Set(["x", ...names.map((name) => name.trim()).filter(Boolean)]);
  const mapped = source.replace(/\b([A-Za-z][A-Za-z0-9]*)\b/g, (token) => {
    const lower = token.toLowerCase();
    if (MATH_FNS.has(lower)) return lower === "ln" ? "Math.log" : `Math.${lower}`;
    if (MATH_CONST.has(lower)) return lower === "pi" ? "Math.PI" : "Math.E";
    if (allowed.has(token) || allowed.has(lower)) return `(scope[${JSON.stringify(token)}] ?? scope[${JSON.stringify(lower)}])`;
    throw new Error(`Unknown symbol '${token}' in ${expr}`);
  });
  const compiled = new Function("scope", `"use strict"; return (${mapped});`) as (scope: Record<string, number>) => unknown;
  return (scope: Record<string, number>) => {
    const value = compiled(scope);
    return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
  };
}

export function graphDocumentStats(source: string) {
  try {
    const document = parseGraphDocument(source);
    return {
      boards: document.boards.length,
      elements: document.boards.reduce((sum, board) => sum + board.elements.length, 0),
    };
  } catch {
    return { boards: 0, elements: 0 };
  }
}
