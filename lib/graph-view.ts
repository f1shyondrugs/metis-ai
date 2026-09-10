export type GraphWindow = {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
};

export function defaultGraphWindow(bounds?: [number, number, number, number]): GraphWindow {
  if (!bounds) return { xmin: -6, xmax: 6, ymin: -4, ymax: 4 };
  return { xmin: bounds[0], xmax: bounds[1], ymin: bounds[2], ymax: bounds[3] };
}

export function zoomGraphWindow(
  win: GraphWindow,
  anchorX: number,
  anchorY: number,
  width: number,
  height: number,
  factor: number,
): GraphWindow {
  if (width <= 0 || height <= 0) return win;
  const scale = Math.min(8, Math.max(0.05, factor));
  const x = win.xmin + (anchorX / width) * (win.xmax - win.xmin);
  const y = win.ymax - (anchorY / height) * (win.ymax - win.ymin);
  return {
    xmin: x - (x - win.xmin) * scale,
    xmax: x + (win.xmax - x) * scale,
    ymin: y - (y - win.ymin) * scale,
    ymax: y + (win.ymax - y) * scale,
  };
}

export function panGraphWindow(
  win: GraphWindow,
  dxPx: number,
  dyPx: number,
  width: number,
  height: number,
): GraphWindow {
  if (width <= 0 || height <= 0) return win;
  const dx = -(dxPx / width) * (win.xmax - win.xmin);
  const dy = (dyPx / height) * (win.ymax - win.ymin);
  return {
    xmin: win.xmin + dx,
    xmax: win.xmax + dx,
    ymin: win.ymin + dy,
    ymax: win.ymax + dy,
  };
}

export function windowToBoundingBox(win: GraphWindow): [number, number, number, number] {
  return [win.xmin, win.ymax, win.xmax, win.ymin];
}
