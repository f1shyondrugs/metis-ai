export type NotesView = { x: number; y: number; zoom: number };

export function pinchDistance(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number },
) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

export function pinchMidpoint(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number },
) {
  return {
    clientX: (a.clientX + b.clientX) / 2,
    clientY: (a.clientY + b.clientY) / 2,
  };
}

export function viewAfterZoom(
  current: NotesView,
  anchorX: number,
  anchorY: number,
  nextZoom: number,
): NotesView {
  const zoom = Math.max(0.2, Math.min(3, nextZoom));
  const contentX = (anchorX - current.x) / current.zoom;
  const contentY = (anchorY - current.y) / current.zoom;
  return {
    zoom,
    x: anchorX - contentX * zoom,
    y: anchorY - contentY * zoom,
  };
}
