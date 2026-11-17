// Zoomable waveform trimmer: an overview strip with a draggable viewport window, a time ruler
// and one detail lane (or an L/R pair) per recording, all sharing one TimelineModel.
//
// Everything that changes per frame (view, playhead, dragging) lives in the model and is drawn
// straight to <canvas> on the next animation frame; React only renders the static structure.

import { Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { cx } from "./ui";
import { MIN_SPAN, type Edge, type TimelineModel } from "./setup/timelineModel";
import { drawHandles, drawLane, drawLaneLabel, drawPlayhead, drawRuler, drawViewport, onThemeChange, type LaneGeometry } from "./setup/waveDraw";

export { TimelineModel } from "./setup/timelineModel";
export type { LaneSpec, TrackSpec, Trim } from "./setup/timelineModel";

const OVERVIEW_H = 40;
const RULER_H = 24;
const LANE_H = 76;
const STEREO_LANE_H = 56;
/** Hit area around a handle, in css px. Grips hang inwards, so the inner side is wider. */
const HANDLE_OUTER = 6;
const HANDLE_INNER = 11;

export interface WaveformRow {
  label: string;
  detail?: string;
  /** CSS variable for the speaker dot, e.g. "--sp1". */
  color: string;
  lanes: number;
  /** Whether this recording is muted in the preview; undefined = no mute button. */
  muted?: boolean;
  onMute?: () => void;
}

// ------------------------------------------------------------------ painting

type Paint = (ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number) => void;

/**
 * Keeps a canvas sized to its css box at devicePixelRatio and repaints it on the next frame
 * whenever the model, the theme or the size changes. `request` schedules an extra repaint.
 */
function usePainter(model: TimelineModel, paint: Paint): { canvasRef: RefObject<HTMLCanvasElement | null>; request: () => void } {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintRef = useRef(paint);
  const frame = useRef(0);

  useLayoutEffect(() => {
    paintRef.current = paint;
  });

  const request = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const c = canvasRef.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(c.clientWidth * dpr));
      const h = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      paintRef.current(ctx, w, h, dpr);
    });
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ro = new ResizeObserver(request);
    ro.observe(c);
    const unModel = model.subscribe(request);
    const unTheme = onThemeChange(request);
    request();
    return () => {
      ro.disconnect();
      unModel();
      unTheme();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [model, request]);

  return { canvasRef, request };
}

/** Pointer x → timeline seconds for the detail view. */
function detailTimeAt(model: TimelineModel, el: HTMLElement, clientX: number): number {
  const r = el.getBoundingClientRect();
  return model.viewStart + ((clientX - r.left) / Math.max(1, r.width)) * model.viewSpan;
}

/** Wheel: zoom around the cursor (vertical wheel, ctrl+wheel = pinch), pan horizontally. */
function useWheel(ref: RefObject<HTMLElement | null>, model: TimelineModel, anchorAt: (clientX: number) => number) {
  const anchorRef = useRef(anchorAt);
  useLayoutEffect(() => {
    anchorRef.current = anchorAt;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      if (e.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      if (Math.abs(dx) > Math.abs(dy)) {
        model.pan((dx / Math.max(1, el.clientWidth)) * model.viewSpan);
      } else if (dy !== 0) {
        // Pinch gestures arrive as ctrl+wheel with small deltas, so they get a stronger factor.
        const k = e.ctrlKey ? 0.01 : 0.0015;
        model.zoomAt(Math.exp(Math.max(-300, Math.min(300, dy)) * k), anchorRef.current(e.clientX));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref, model]);
}

// ------------------------------------------------------------------ overview

function Overview({ model }: { model: TimelineModel }) {
  const hot = useRef(false);
  const drag = useRef<{ mode: "pan" | "left" | "right"; grab: number } | null>(null);

  const { canvasRef, request } = usePainter(model, (ctx, w, h, dpr) => {
    const ext = model.extent;
    const g: LaneGeometry = { x: 0, y: 0, w, h, viewStart: ext.start, spp: (ext.end - ext.start) / w, dpr };
    const bands = model.tracks.reduce((n, t) => n + t.lanes.length, 0) || 1;
    const bandH = h / bands;
    let y = 0;
    model.tracks.forEach((t, i) => {
      for (const lane of t.lanes) {
        drawLane(ctx, { ...g, y, h: bandH }, lane, t.offset, t.duration, model.trims[i], { compact: true });
        y += bandH;
      }
    });
    drawPlayhead(ctx, g, model.playhead);
    drawViewport(ctx, g, model.viewStart, model.viewSpan, hot.current || drag.current !== null);
  });

  const geometry = (clientX: number) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    const ext = model.extent;
    const spp = (ext.end - ext.start) / Math.max(1, r.width);
    const x = clientX - r.left;
    const x0 = (model.viewStart - ext.start) / spp;
    const x1 = x0 + Math.max(6, model.viewSpan / spp);
    return { t: ext.start + x * spp, x, x0, x1 };
  };

  const zoneAt = (clientX: number): "left" | "right" | "pan" | null => {
    const { x, x0, x1 } = geometry(clientX);
    if (Math.abs(x - x0) <= 5) return "left";
    if (Math.abs(x - x1) <= 5) return "right";
    if (x > x0 && x < x1) return "pan";
    return null;
  };

  useWheel(canvasRef, model, (clientX) => geometry(clientX).t);

  return (
    <canvas
      ref={canvasRef}
      className="block w-full touch-none rounded-lg"
      style={{ height: OVERVIEW_H }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const g = geometry(e.clientX);
        let mode = zoneAt(e.clientX);
        if (!mode) {
          // Jump: centre the window on the click, then keep dragging it.
          model.setView(g.t - model.viewSpan / 2, model.viewSpan);
          mode = "pan";
        }
        drag.current = { mode, grab: geometry(e.clientX).t - model.viewStart };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.style.cursor = mode === "pan" ? "grabbing" : "ew-resize";
        request();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        const g = geometry(e.clientX);
        if (d) {
          const end = model.viewStart + model.viewSpan;
          if (d.mode === "pan") model.setView(g.t - d.grab, model.viewSpan);
          else if (d.mode === "left") {
            const span = Math.max(MIN_SPAN, end - g.t);
            model.setView(end - span, span);
          } else {
            model.setView(model.viewStart, Math.max(MIN_SPAN, g.t - model.viewStart));
          }
          return;
        }
        const zone = zoneAt(e.clientX);
        e.currentTarget.style.cursor = zone === "pan" ? "grab" : zone ? "ew-resize" : "pointer";
        if (hot.current !== (zone !== null)) {
          hot.current = zone !== null;
          request();
        }
      }}
      onPointerUp={(e) => {
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        const zone = zoneAt(e.clientX);
        e.currentTarget.style.cursor = zone === "pan" ? "grab" : zone ? "ew-resize" : "pointer";
        request();
      }}
      onPointerLeave={() => {
        if (hot.current && !drag.current) {
          hot.current = false;
          request();
        }
      }}
    />
  );
}

// ------------------------------------------------------------------ ruler

function Ruler({ model }: { model: TimelineModel }) {
  const scrubbing = useRef(false);
  const { canvasRef } = usePainter(model, (ctx, w, h, dpr) => {
    drawRuler(ctx, { x: 0, y: 0, w, h, viewStart: model.viewStart, spp: model.viewSpan / w, dpr }, model.playhead);
  });
  return (
    <canvas
      ref={canvasRef}
      className="block w-full cursor-pointer touch-none"
      style={{ height: RULER_H }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        scrubbing.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        model.seek(detailTimeAt(model, e.currentTarget, e.clientX));
      }}
      onPointerMove={(e) => {
        if (scrubbing.current) model.seek(detailTimeAt(model, e.currentTarget, e.clientX));
      }}
      onPointerUp={(e) => {
        scrubbing.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    />
  );
}

// ------------------------------------------------------------------ detail lanes

function TrackLanes({ model, index, height }: { model: TimelineModel; index: number; height: number }) {
  const hot = useRef<Edge | null>(null);
  const drag = useRef<{ kind: "edge"; edge: Edge; grab: number } | { kind: "scrub" } | null>(null);

  const { canvasRef, request } = usePainter(model, (ctx, w, h, dpr) => {
    const t = model.tracks[index];
    const trim = model.trims[index];
    if (!t || !trim) return;
    const base: LaneGeometry = { x: 0, y: 0, w, h, viewStart: model.viewStart, spp: model.viewSpan / w, dpr };
    const gap = t.lanes.length > 1 ? Math.round(2 * dpr) : 0;
    const laneH = (h - gap * (t.lanes.length - 1)) / t.lanes.length;
    t.lanes.forEach((lane, j) => {
      const g = { ...base, y: j * (laneH + gap), h: laneH };
      drawLane(ctx, g, lane, t.offset, t.duration, trim);
      if (lane.label) drawLaneLabel(ctx, g, lane.label, lane.color);
    });
    drawHandles(ctx, base, trim, t.offset, drag.current?.kind === "edge" ? drag.current.edge : hot.current);
    drawPlayhead(ctx, base, model.playhead);
  });

  /** The handle under the pointer, if any. */
  const edgeAt = (el: HTMLElement, clientX: number): Edge | null => {
    const r = el.getBoundingClientRect();
    const pxPerSec = r.width / model.viewSpan;
    const x = clientX - r.left;
    const sel = model.trimOnTimeline(index);
    const xIn = (sel.start - model.viewStart) * pxPerSec;
    const xOut = (sel.end - model.viewStart) * pxPerSec;
    const inHit = x >= xIn - HANDLE_OUTER && x <= xIn + HANDLE_INNER;
    const outHit = x >= xOut - HANDLE_INNER && x <= xOut + HANDLE_OUTER;
    if (inHit && outHit) return Math.abs(x - xIn) <= Math.abs(x - xOut) ? "in" : "out";
    return inHit ? "in" : outHit ? "out" : null;
  };

  const setHot = (edge: Edge | null) => {
    if (hot.current !== edge) {
      hot.current = edge;
      request();
    }
  };

  return (
    <canvas
      ref={canvasRef}
      className="block w-full touch-none rounded-lg"
      style={{ height }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const edge = edgeAt(el, e.clientX);
        if (edge) {
          const sel = model.trimOnTimeline(index);
          drag.current = { kind: "edge", edge, grab: detailTimeAt(model, el, e.clientX) - (edge === "in" ? sel.start : sel.end) };
          request();
        } else {
          drag.current = { kind: "scrub" };
          model.seek(detailTimeAt(model, el, e.clientX));
        }
      }}
      onPointerMove={(e) => {
        const el = e.currentTarget;
        const d = drag.current;
        if (!d) {
          const edge = edgeAt(el, e.clientX);
          el.style.cursor = edge ? "ew-resize" : "pointer";
          setHot(edge);
          return;
        }
        if (d.kind === "scrub") {
          model.seek(detailTimeAt(model, el, e.clientX));
          return;
        }
        // Nudge the view along when a handle is dragged against either side.
        const r = el.getBoundingClientRect();
        const x = e.clientX - r.left;
        if (x < 12) model.pan(-model.viewSpan * 0.01);
        else if (x > r.width - 12) model.pan(model.viewSpan * 0.01);
        const t = detailTimeAt(model, el, e.clientX) - d.grab;
        model.setEdge(index, d.edge, model.fileTime(index, t));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        request();
      }}
      onPointerLeave={() => {
        if (!drag.current) setHot(null);
      }}
    />
  );
}

// ------------------------------------------------------------------ public component

/** The active track index, re-rendered only when it changes. */
function useActive(model: TimelineModel): number {
  const [active, setActive] = useState(model.active);
  useEffect(() => {
    setActive(model.active);
    return model.subscribe((e) => {
      if (e === "active" || e === "tracks") setActive(model.active);
    });
  }, [model]);
  return active;
}

export function Waveform({
  model,
  rows,
  selectable,
  activeHint,
  muteLabels,
}: {
  model: TimelineModel;
  rows: WaveformRow[];
  /** Whether clicking a row header makes that recording the one that plays. */
  selectable: boolean;
  /** Tooltip-ish title for selectable headers. */
  activeHint?: string;
  /** Labels of the per-recording mute button. */
  muteLabels?: { mute: string; unmute: string };
}) {
  const detailRef = useRef<HTMLDivElement | null>(null);
  const active = useActive(model);

  useWheel(detailRef, model, (clientX) => {
    const el = detailRef.current?.querySelector("canvas");
    return el ? detailTimeAt(model, el, clientX) : model.viewStart;
  });

  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2">
      <div />
      <Overview model={model} />

      <div ref={detailRef} className="col-span-2 grid grid-cols-subgrid gap-y-2">
        <div />
        <Ruler model={model} />
        {rows.map((row, i) => {
          const isActive = selectable && i === active;
          const height = row.lanes > 1 ? STEREO_LANE_H * row.lanes : LANE_H;
          return (
            <div
              key={i}
              className="col-span-2 grid grid-cols-subgrid"
              // The recording under the pointer is the one I/O and the readouts apply to.
              onPointerEnter={() => selectable && model.setActive(i)}
            >
              <div
                className={cx("flex min-w-0 items-center gap-1 rounded-lg pr-1 transition-colors", isActive ? "bg-accent-soft" : selectable && "hover:bg-surface-2")}
                style={{ height }}
              >
                <button
                  type="button"
                  disabled={!selectable}
                  title={selectable ? activeHint : undefined}
                  onClick={() => model.setActive(i)}
                  className="flex h-full min-w-0 flex-1 flex-col items-start justify-center gap-0.5 pl-2.5 text-left disabled:cursor-default"
                >
                  <span className="flex w-full min-w-0 items-center gap-1.5 text-[13px] font-medium text-fg">
                    <span className="size-2 shrink-0 rounded-full" style={{ background: `var(${row.color})` }} />
                    <span className="truncate">{row.label}</span>
                  </span>
                  {row.detail && <span className="w-full truncate text-xs text-muted">{row.detail}</span>}
                </button>
                {row.onMute && (
                  <button
                    type="button"
                    onClick={row.onMute}
                    aria-pressed={row.muted}
                    aria-label={row.muted ? muteLabels?.unmute : muteLabels?.mute}
                    title={row.muted ? muteLabels?.unmute : muteLabels?.mute}
                    className={cx("flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-surface-3", row.muted ? "text-danger" : "text-muted")}
                  >
                    {row.muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
                  </button>
                )}
              </div>
              <TrackLanes model={model} index={i} height={height} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
