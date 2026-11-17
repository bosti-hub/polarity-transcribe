// Canvas drawing for the setup timeline: theme colours, a max-pyramid over the peaks so that
// hours of audio render quickly at any zoom, and the lane / ruler / overview painters.

import { formatClock } from "@/lib/transcript";
import { PEAKS_PER_SECOND, type LaneSpec, type Trim } from "./timelineModel";

// ------------------------------------------------------------------ colours

export interface Palette {
  surface: string;
  surface2: string;
  surface3: string;
  line: string;
  lineStrong: string;
  fg: string;
  muted: string;
  accent: string;
  accentSoft: string;
  bg: string;
  /** Resolves a lane colour variable such as "--sp1". */
  v: (name: string) => string;
}

let palette: Palette | null = null;

export function getPalette(): Palette {
  if (palette) return palette;
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => style.getPropertyValue(name).trim() || "gray";
  const cache = new Map<string, string>();
  palette = {
    surface: v("--surface"),
    surface2: v("--surface-2"),
    surface3: v("--surface-3"),
    line: v("--line"),
    lineStrong: v("--line-strong"),
    fg: v("--fg"),
    muted: v("--muted"),
    accent: v("--accent"),
    accentSoft: v("--accent-soft"),
    bg: v("--bg"),
    v: (name) => {
      let c = cache.get(name);
      if (c === undefined) {
        c = v(name);
        cache.set(name, c);
      }
      return c;
    },
  };
  return palette;
}

const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

/** Calls `cb` whenever the light/dark theme changes. Returns an unsubscribe function. */
export function onThemeChange(cb: () => void): () => void {
  themeListeners.add(cb);
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => {
      palette = null;
      themeListeners.forEach((fn) => fn());
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  }
  return () => {
    themeListeners.delete(cb);
    if (themeListeners.size === 0 && themeObserver) {
      themeObserver.disconnect();
      themeObserver = null;
    }
  };
}

// ------------------------------------------------------------------ peaks

const pyramids = new WeakMap<Uint8Array, Uint8Array[]>();

/** Level k holds the max of each 2^k consecutive peaks. */
function pyramid(peaks: Uint8Array): Uint8Array[] {
  let levels = pyramids.get(peaks);
  if (levels) return levels;
  levels = [peaks];
  let cur = peaks;
  while (cur.length > 1) {
    const next = new Uint8Array(Math.ceil(cur.length / 2));
    for (let i = 0; i < next.length; i++) {
      const a = cur[2 * i];
      const b = 2 * i + 1 < cur.length ? cur[2 * i + 1] : 0;
      next[i] = a > b ? a : b;
    }
    levels.push(next);
    cur = next;
  }
  pyramids.set(peaks, levels);
  return levels;
}

/** Max peak over the index range [i0, i1), or -1 when the range is outside the file. */
function peakMax(levels: Uint8Array[], i0: number, i1: number): number {
  const n = levels[0].length;
  let lo = Math.floor(i0);
  let hi = Math.max(lo + 1, Math.ceil(i1));
  if (hi <= 0 || lo >= n) return -1;
  lo = Math.max(0, lo);
  hi = Math.min(n, hi);
  const count = hi - lo;
  // Pick the level where the range spans only a handful of entries (slight over-coverage is fine).
  const level = Math.min(levels.length - 1, Math.max(0, Math.floor(Math.log2(count)) - 1));
  const arr = levels[level];
  const a = lo >> level;
  const b = (hi - 1) >> level;
  let m = 0;
  for (let i = a; i <= b; i++) if (arr[i] > m) m = arr[i];
  return m;
}

/** Element-wise max of two channels, for a stereo file shown as one lane. */
export function mergePeaks(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = Math.max(a[i] ?? 0, b[i] ?? 0);
  return out;
}

// ------------------------------------------------------------------ lanes

export interface LaneGeometry {
  /** Device pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Timeline seconds at x. */
  viewStart: number;
  /** Timeline seconds per device pixel. */
  spp: number;
  dpr: number;
}

/** Background well, selection tint and waveform of one lane. */
export function drawLane(
  ctx: CanvasRenderingContext2D,
  g: LaneGeometry,
  lane: LaneSpec,
  offset: number,
  duration: number,
  trim: Trim,
  opts: { compact?: boolean } = {},
) {
  const p = getPalette();
  const toX = (fileT: number) => g.x + (fileT - offset - g.viewStart) / g.spp;
  const fileX0 = Math.max(g.x, toX(0));
  const fileX1 = Math.min(g.x + g.w, toX(duration));
  if (fileX1 <= fileX0) return;

  ctx.fillStyle = p.surface2;
  ctx.fillRect(fileX0, g.y, fileX1 - fileX0, g.h);

  const selX0 = Math.max(g.x, toX(trim.start));
  const selX1 = Math.min(g.x + g.w, toX(trim.end));
  if (selX1 > selX0) {
    ctx.fillStyle = p.accentSoft;
    ctx.fillRect(selX0, g.y, selX1 - selX0, g.h);
  }

  const mid = g.y + g.h / 2;
  const amp = (g.h / 2) * (opts.compact ? 0.9 : 0.86);
  const minH = Math.max(1, g.dpr * 0.75);

  // Baseline so silent stretches still read as part of the file.
  ctx.fillStyle = p.lineStrong;
  ctx.fillRect(fileX0, mid - minH / 2, fileX1 - fileX0, minH);

  if (!lane.peaks || lane.peaks.length === 0) return;
  const levels = pyramid(lane.peaks);
  const inside = new Path2D();
  const outside = new Path2D();
  const pxPerPeak = 1 / (g.spp * PEAKS_PER_SECOND);

  if (pxPerPeak >= 3 * g.dpr) {
    // Zoomed in: one rounded bar per peak with a gap.
    const gap = Math.max(1, g.dpr);
    const first = Math.max(0, Math.floor((g.viewStart + offset) * PEAKS_PER_SECOND));
    const last = Math.min(lane.peaks.length - 1, Math.ceil((g.viewStart + g.w * g.spp + offset) * PEAKS_PER_SECOND));
    for (let i = first; i <= last; i++) {
      const x = toX(i / PEAKS_PER_SECOND);
      const hh = Math.max(minH, (lane.peaks[i] / 255) * amp);
      const fileT = (i + 0.5) / PEAKS_PER_SECOND;
      const path = fileT >= trim.start && fileT <= trim.end ? inside : outside;
      path.rect(x + gap / 2, mid - hh, Math.max(1, pxPerPeak - gap), hh * 2);
    }
  } else {
    // Zoomed out: the max over every device-pixel column.
    const x0 = Math.floor(fileX0);
    const x1 = Math.ceil(fileX1);
    const step = 1;
    for (let x = x0; x < x1; x += step) {
      const t = g.viewStart + (x - g.x) * g.spp + offset;
      const v = peakMax(levels, t * PEAKS_PER_SECOND, (t + g.spp * step) * PEAKS_PER_SECOND);
      if (v < 0) continue;
      const hh = Math.max(minH, (v / 255) * amp);
      const path = t >= trim.start && t <= trim.end ? inside : outside;
      path.rect(x, mid - hh, step, hh * 2);
    }
  }
  ctx.fillStyle = p.lineStrong;
  ctx.fill(outside);
  ctx.fillStyle = p.v(lane.color);
  ctx.fill(inside);
}

/** In/out handles across a track (all its lanes). `hot` highlights a hovered or dragged edge. */
export function drawHandles(
  ctx: CanvasRenderingContext2D,
  g: LaneGeometry,
  trim: Trim,
  offset: number,
  hot: "in" | "out" | null,
) {
  const p = getPalette();
  const lineW = Math.max(1.5, 2 * g.dpr * 0.75);
  for (const edge of ["in", "out"] as const) {
    const fileT = edge === "in" ? trim.start : trim.end;
    const x = g.x + (fileT - offset - g.viewStart) / g.spp;
    if (x < g.x - 10 * g.dpr || x > g.x + g.w + 10 * g.dpr) continue;
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - lineW / 2, g.y, lineW, g.h);
    // Grip: a rounded tab hanging inwards from the top, like a bracket.
    const gw = (hot === edge ? 9 : 7) * g.dpr;
    const gh = Math.min(g.h * 0.5, 26 * g.dpr);
    const gx = edge === "in" ? x - lineW / 2 : x + lineW / 2 - gw;
    const gy = g.y + (g.h - gh) / 2;
    ctx.beginPath();
    ctx.roundRect(gx, gy, gw, gh, 3 * g.dpr);
    ctx.fill();
    ctx.fillStyle = p.surface;
    const cx = gx + gw / 2 - 0.5 * g.dpr;
    ctx.fillRect(cx, gy + gh * 0.3, Math.max(1, g.dpr), gh * 0.4);
  }
}

export function drawPlayhead(ctx: CanvasRenderingContext2D, g: LaneGeometry, t: number) {
  const x = g.x + (t - g.viewStart) / g.spp;
  if (x < g.x - 2 || x > g.x + g.w + 2) return;
  ctx.fillStyle = getPalette().fg;
  const w = Math.max(1, 1.5 * g.dpr);
  ctx.fillRect(Math.round(x - w / 2), g.y, w, g.h);
}

export function drawLaneLabel(ctx: CanvasRenderingContext2D, g: LaneGeometry, text: string, color: string) {
  const p = getPalette();
  ctx.font = `600 ${10 * g.dpr}px "Inter Variable", system-ui, sans-serif`;
  ctx.textBaseline = "top";
  const pad = 6 * g.dpr;
  const w = ctx.measureText(text).width + pad;
  ctx.fillStyle = p.surface;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.roundRect(g.x + 4 * g.dpr, g.y + 4 * g.dpr, w, 14 * g.dpr, 4 * g.dpr);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = p.v(color);
  ctx.fillText(text, g.x + 4 * g.dpr + pad / 2, g.y + 6.5 * g.dpr);
}

// ------------------------------------------------------------------ ruler

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

function formatTick(t: number, step: number): string {
  const sign = t < -1e-6 ? "-" : "";
  return sign + formatClock(Math.abs(t), step < 1);
}

/** Time ruler with adaptive ticks: labelled majors at least ~90 css px apart, and minor ticks. */
export function drawRuler(ctx: CanvasRenderingContext2D, g: LaneGeometry, playhead: number) {
  const p = getPalette();
  const pxPerSec = 1 / g.spp;
  const major = TICK_STEPS.find((s) => s * pxPerSec >= 90 * g.dpr) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const minor = TICK_STEPS.slice()
    .reverse()
    .find((s) => {
      const r = major / s;
      return s < major && Math.abs(r - Math.round(r)) < 1e-6 && s * pxPerSec >= 8 * g.dpr;
    });

  ctx.font = `500 ${10.5 * g.dpr}px "Inter Variable", system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillStyle = p.lineStrong;
  const end = g.viewStart + g.w * g.spp;

  // Integer tick indices avoid floating-point drift over hours of ticks.
  if (minor) {
    for (let k = Math.ceil(g.viewStart / minor); k * minor <= end; k++) {
      const x = Math.round(g.x + (k * minor - g.viewStart) / g.spp);
      ctx.fillRect(x, g.y + g.h - 4 * g.dpr, Math.max(1, g.dpr * 0.75), 4 * g.dpr);
    }
  }
  for (let k = Math.ceil(g.viewStart / major); k * major <= end; k++) {
    const t = k * major;
    const x = Math.round(g.x + (t - g.viewStart) / g.spp);
    ctx.fillStyle = p.lineStrong;
    ctx.fillRect(x, g.y + g.h - 8 * g.dpr, Math.max(1, g.dpr), 8 * g.dpr);
    ctx.fillStyle = p.muted;
    ctx.fillText(formatTick(Math.round(t * 10) / 10, major), x + 4 * g.dpr, g.y + g.h / 2 - 2 * g.dpr);
  }

  // Playhead marker: a small downward triangle.
  const px = g.x + (playhead - g.viewStart) / g.spp;
  if (px >= g.x - 6 * g.dpr && px <= g.x + g.w + 6 * g.dpr) {
    const s = 5 * g.dpr;
    ctx.fillStyle = p.fg;
    ctx.beginPath();
    ctx.moveTo(px - s, g.y + g.h - s * 1.4);
    ctx.lineTo(px + s, g.y + g.h - s * 1.4);
    ctx.lineTo(px, g.y + g.h);
    ctx.closePath();
    ctx.fill();
  }
}

// ------------------------------------------------------------------ overview window

/** The visible part of the detail view, drawn on the overview strip. */
export function drawViewport(ctx: CanvasRenderingContext2D, g: LaneGeometry, start: number, span: number, hot: boolean) {
  const p = getPalette();
  const x0 = g.x + (start - g.viewStart) / g.spp;
  const w = Math.max(6 * g.dpr, span / g.spp);
  // Dim everything outside the window.
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = p.surface;
  ctx.fillRect(g.x, g.y, Math.max(0, x0 - g.x), g.h);
  ctx.fillRect(x0 + w, g.y, Math.max(0, g.x + g.w - x0 - w), g.h);
  ctx.globalAlpha = 1;
  const lw = (hot ? 2 : 1.5) * g.dpr;
  ctx.strokeStyle = p.accent;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.roundRect(x0 + lw / 2, g.y + lw / 2, w - lw, g.h - lw, 5 * g.dpr);
  ctx.stroke();
}
