export interface PanelSize {
  width: number;
  height: number;
}

export interface PanelResizeOptions {
  position: "bottom-right" | "bottom-left";
  resizable?: boolean;
  defaultWidth?: number;
  defaultHeight?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  persistSize?: boolean;
  storageKey?: string;
}

const DEFAULT_SIZE: PanelSize = { width: 380, height: 520 };
const MIN_SIZE: PanelSize = { width: 300, height: 380 };
const VIEWPORT_MARGIN = 32;
const BOTTOM_CLEARANCE = 120;

function getViewportMaxSize(): PanelSize {
  if (typeof window === "undefined") return DEFAULT_SIZE;
  return {
    width: window.innerWidth - VIEWPORT_MARGIN,
    height: window.innerHeight - BOTTOM_CLEARANCE,
  };
}

function loadStoredSize(key: string): PanelSize | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PanelSize>;
    if (typeof parsed.width === "number" && typeof parsed.height === "number") {
      return { width: parsed.width, height: parsed.height };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveStoredSize(key: string, size: PanelSize): void {
  try {
    localStorage.setItem(key, JSON.stringify(size));
  } catch {
    /* ignore */
  }
}

function clampSize(size: PanelSize, opts: PanelResizeOptions): PanelSize {
  const viewportMax = getViewportMaxSize();
  const minW = opts.minWidth ?? MIN_SIZE.width;
  const minH = opts.minHeight ?? MIN_SIZE.height;
  const maxW = Math.min(opts.maxWidth ?? viewportMax.width, viewportMax.width);
  const maxH = Math.min(opts.maxHeight ?? viewportMax.height, viewportMax.height);

  return {
    width: Math.round(Math.min(maxW, Math.max(minW, size.width))),
    height: Math.round(Math.min(maxH, Math.max(minH, size.height))),
  };
}

function resolveInitialSize(opts: PanelResizeOptions): PanelSize {
  const storageKey = opts.storageKey ?? "commerce-agent-panel-size";
  const stored =
    opts.persistSize !== false ? loadStoredSize(storageKey) : null;

  const base: PanelSize = stored ?? {
    width: opts.defaultWidth ?? DEFAULT_SIZE.width,
    height: opts.defaultHeight ?? DEFAULT_SIZE.height,
  };

  return clampSize(base, opts);
}

function applyPanelSize(panel: HTMLElement, size: PanelSize): void {
  panel.style.width = `${size.width}px`;
  panel.style.height = `${size.height}px`;
  panel.style.maxWidth = `${size.width}px`;
  panel.style.maxHeight = `${size.height}px`;
}

type ResizeAxis = "both" | "width" | "height";

function createResizeHandle(className: string, axis: ResizeAxis): HTMLDivElement {
  const handle = document.createElement("div");
  handle.className = `ca-resize-handle ${className}`;
  handle.dataset.axis = axis;
  handle.setAttribute("aria-hidden", axis === "both" ? "false" : "true");
  if (axis === "both") {
    handle.setAttribute("aria-label", "Resize panel");
    handle.title = "Drag to resize";
  }
  return handle;
}

export function setupPanelResize(
  panel: HTMLElement,
  opts: PanelResizeOptions,
): () => void {
  if (opts.resizable === false) return () => undefined;

  const position = opts.position ?? "bottom-right";
  const storageKey = opts.storageKey ?? "commerce-agent-panel-size";
  let size = resolveInitialSize(opts);
  applyPanelSize(panel, size);

  const cornerClass = position === "bottom-right" ? "ca-resize-nw" : "ca-resize-ne";
  const sideClass = position === "bottom-right" ? "ca-resize-w" : "ca-resize-e";

  panel.append(
    createResizeHandle(cornerClass, "both"),
    createResizeHandle("ca-resize-n", "height"),
    createResizeHandle(sideClass, "width"),
  );

  let dragging = false;
  let axis: ResizeAxis = "both";
  let startX = 0;
  let startY = 0;
  let startSize: PanelSize = size;
  let activeHandle: HTMLElement | null = null;

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return;

    const deltaX = startX - event.clientX;
    const deltaY = startY - event.clientY;

    let nextWidth = startSize.width;
    let nextHeight = startSize.height;

    if (axis === "both" || axis === "width") {
      nextWidth =
        position === "bottom-right"
          ? startSize.width + deltaX
          : startSize.width + (event.clientX - startX);
    }

    if (axis === "both" || axis === "height") {
      nextHeight = startSize.height + deltaY;
    }

    size = clampSize({ width: nextWidth, height: nextHeight }, opts);
    applyPanelSize(panel, size);
  };

  const stopDragging = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove("ca-panel-resizing");
    document.body.style.userSelect = "";
    if (activeHandle?.hasPointerCapture(event.pointerId)) {
      activeHandle.releasePointerCapture(event.pointerId);
    }
    activeHandle = null;
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", stopDragging);
    document.removeEventListener("pointercancel", stopDragging);

    if (opts.persistSize !== false) {
      saveStoredSize(storageKey, size);
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    axis = (handle.dataset.axis as ResizeAxis) ?? "both";
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    startSize = { ...size };
    panel.classList.add("ca-panel-resizing");
    document.body.style.userSelect = "none";
    activeHandle = handle;
    handle.setPointerCapture(event.pointerId);
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", stopDragging);
    document.addEventListener("pointercancel", stopDragging);
    event.preventDefault();
  };

  const handles = panel.querySelectorAll<HTMLElement>(".ca-resize-handle");
  handles.forEach((handle) => handle.addEventListener("pointerdown", onPointerDown));

  const onWindowResize = (): void => {
    size = clampSize(size, opts);
    applyPanelSize(panel, size);
  };
  window.addEventListener("resize", onWindowResize);

  return () => {
    window.removeEventListener("resize", onWindowResize);
    handles.forEach((handle) => handle.removeEventListener("pointerdown", onPointerDown));
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", stopDragging);
    document.removeEventListener("pointercancel", stopDragging);
  };
}
