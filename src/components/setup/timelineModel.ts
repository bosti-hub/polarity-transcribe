// View state and trim logic for the setup timeline. It lives outside React so that dragging,
// zooming and playback can update the canvases every frame without re-rendering components:
// the canvases subscribe and redraw on the next animation frame.
//
// Times: the timeline uses "timeline seconds" (the time of recording 1). Every track has an
// `offset` such that `file time = timeline time + offset`. Trims are stored in file time.

export const PEAKS_PER_SECOND = 50;
/** Narrowest zoom: about this many seconds across the view. */
export const MIN_SPAN = 5;
/** In and out are kept at least this far apart. */
export const MIN_SELECTION = 0.5;

export interface LaneSpec {
  peaks: Uint8Array | null;
  /** CSS variable holding the lane colour, e.g. "--sp1". */
  color: string;
  /** Small label drawn inside the lane, e.g. "L" / "R". */
  label?: string;
}

export interface TrackSpec {
  /** Identity of the underlying file; trims survive a rebuild with the same key. */
  key: string;
  slot: number;
  duration: number;
  /** file time = timeline time + offset */
  offset: number;
  lanes: LaneSpec[];
}

export interface Trim {
  start: number;
  end: number;
}

export type Edge = "in" | "out";

/**
 * - tracks: the set of tracks changed (also peaks arriving)
 * - view: zoom / scroll changed
 * - trim: an in or out point changed
 * - playhead: the playhead moved (playback or user)
 * - seek: the user moved the playhead (audio should follow)
 * - active: the active (played) track changed
 */
export type ModelEvent = "tracks" | "view" | "trim" | "playhead" | "seek" | "active";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class TimelineModel {
  tracks: TrackSpec[] = [];
  trims: Trim[] = [];
  linked = false;
  active = 0;
  /** Timeline seconds. */
  playhead = 0;
  viewStart = 0;
  viewSpan = 60;

  private listeners = new Set<(e: ModelEvent) => void>();

  subscribe(fn: (e: ModelEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(e: ModelEvent) {
    for (const fn of this.listeners) fn(e);
  }

  // ------------------------------------------------------------- geometry

  /** Timeline range covered by all tracks. */
  get extent(): { start: number; end: number } {
    if (this.tracks.length === 0) return { start: 0, end: 1 };
    let start = Infinity;
    let end = -Infinity;
    for (const t of this.tracks) {
      start = Math.min(start, -t.offset);
      end = Math.max(end, t.duration - t.offset);
    }
    return { start, end: Math.max(end, start + 1) };
  }

  fileTime(track: number, t: number): number {
    return t + (this.tracks[track]?.offset ?? 0);
  }

  timelineTime(track: number, f: number): number {
    return f - (this.tracks[track]?.offset ?? 0);
  }

  /** The selection of a track in timeline seconds. */
  trimOnTimeline(track: number): Trim {
    const tr = this.trims[track];
    const off = this.tracks[track]?.offset ?? 0;
    return tr ? { start: tr.start - off, end: tr.end - off } : { start: 0, end: 0 };
  }

  // ------------------------------------------------------------- tracks

  setTracks(tracks: TrackSpec[], trims: Trim[]) {
    const prev = this.tracks;
    const prevTrims = this.trims;
    const oldExtent = this.extent;
    const wasFitted = prev.length === 0 || this.viewSpan >= oldExtent.end - oldExtent.start - 1e-6;

    this.trims = tracks.map((t, i) => {
      const old = prev.findIndex((p) => p.key === t.key);
      const base = old >= 0 ? prevTrims[old] : (trims[i] ?? { start: 0, end: t.duration });
      return normaliseTrim(base, t.duration);
    });
    this.tracks = tracks;
    if (this.active >= tracks.length) this.active = 0;

    const ext = this.extent;
    if (wasFitted) {
      this.viewStart = ext.start;
      this.viewSpan = ext.end - ext.start;
    } else {
      this.clampView();
    }
    this.playhead = clamp(this.playhead, ext.start, ext.end);
    const synced = this.linked && this.syncLinked(this.active);
    this.emit("tracks");
    if (synced) this.emit("trim");
  }

  // ------------------------------------------------------------- trims

  setLinked(linked: boolean) {
    if (this.linked === linked) return;
    this.linked = linked;
    if (linked && this.syncLinked(this.active)) this.emit("trim");
  }

  /** Move one edge of a track's selection (file time). Linked tracks follow. */
  setEdge(track: number, edge: Edge, fileTime: number) {
    const t = this.tracks[track];
    const tr = this.trims[track];
    if (!t || !tr) return;
    this.trims[track] = applyEdge(tr, edge, fileTime, t.duration);
    if (this.linked) this.syncLinked(track);
    this.emit("trim");
  }

  /** Replace a track's whole selection (file time); returns false if it is not valid. */
  setTrim(track: number, trim: Trim): boolean {
    const t = this.tracks[track];
    if (!t) return false;
    const start = clamp(trim.start, 0, t.duration);
    const end = clamp(trim.end, 0, t.duration);
    if (end - start < MIN_SELECTION) return false;
    this.trims[track] = { start, end };
    if (this.linked) this.syncLinked(track);
    this.emit("trim");
    return true;
  }

  reset() {
    this.trims = this.tracks.map((t) => ({ start: 0, end: t.duration }));
    if (this.linked) this.syncLinked(0);
    this.emit("trim");
  }

  /** Make every other track select the same moment as `from`. Returns true if anything changed. */
  private syncLinked(from: number): boolean {
    const src = this.trims[from];
    const srcTrack = this.tracks[from];
    if (!src || !srcTrack) return false;
    const t0 = src.start - srcTrack.offset;
    const t1 = src.end - srcTrack.offset;
    let changed = false;
    this.tracks.forEach((t, i) => {
      if (i === from) return;
      const next = normaliseTrim({ start: t0 + t.offset, end: t1 + t.offset }, t.duration);
      const cur = this.trims[i];
      if (!cur || Math.abs(cur.start - next.start) > 1e-6 || Math.abs(cur.end - next.end) > 1e-6) {
        this.trims[i] = next;
        changed = true;
      }
    });
    return changed;
  }

  /** True when all tracks already select the same moment (within 50 ms). */
  isConsistent(): boolean {
    if (this.tracks.length < 2) return true;
    const a = this.trimOnTimeline(0);
    return this.tracks.every((_, i) => {
      const b = this.trimOnTimeline(i);
      return Math.abs(a.start - b.start) < 0.05 && Math.abs(a.end - b.end) < 0.05;
    });
  }

  // ------------------------------------------------------------- view

  private clampView() {
    const ext = this.extent;
    const full = ext.end - ext.start;
    this.viewSpan = clamp(this.viewSpan, Math.min(MIN_SPAN, full), full);
    this.viewStart = clamp(this.viewStart, ext.start, ext.end - this.viewSpan);
  }

  setView(start: number, span: number) {
    this.viewStart = start;
    this.viewSpan = span;
    this.clampView();
    this.emit("view");
  }

  /** Zoom by `factor` (< 1 zooms in) keeping timeline time `anchor` at the same screen position. */
  zoomAt(factor: number, anchor: number) {
    const ratio = (anchor - this.viewStart) / this.viewSpan;
    const ext = this.extent;
    const span = clamp(this.viewSpan * factor, Math.min(MIN_SPAN, ext.end - ext.start), ext.end - ext.start);
    this.setView(anchor - ratio * span, span);
  }

  /** Zoom around the playhead when it is visible, else around the centre of the view. */
  zoomBy(factor: number) {
    const visible = this.playhead >= this.viewStart && this.playhead <= this.viewStart + this.viewSpan;
    this.zoomAt(factor, visible ? this.playhead : this.viewStart + this.viewSpan / 2);
  }

  pan(seconds: number) {
    this.setView(this.viewStart + seconds, this.viewSpan);
  }

  fit() {
    const ext = this.extent;
    this.setView(ext.start, ext.end - ext.start);
  }

  // ------------------------------------------------------------- playhead

  /** Move the playhead (timeline seconds). With `follow`, the view pages along with it. */
  setPlayhead(t: number, follow = false) {
    const ext = this.extent;
    this.playhead = clamp(t, ext.start, ext.end);
    if (follow) {
      const end = this.viewStart + this.viewSpan;
      if (this.playhead > end || this.playhead < this.viewStart) {
        this.viewStart = this.playhead - this.viewSpan * 0.05;
        this.clampView();
        this.emit("view");
      }
    }
    this.emit("playhead");
  }

  /** A playhead move made by the user: playback should jump there too. */
  seek(t: number) {
    this.setPlayhead(t);
    this.emit("seek");
  }

  setActive(track: number) {
    if (track === this.active || !this.tracks[track]) return;
    this.active = track;
    this.emit("active");
  }
}

function normaliseTrim(tr: Trim, duration: number): Trim {
  let start = clamp(tr.start, 0, duration);
  let end = clamp(tr.end, 0, duration);
  if (end - start < MIN_SELECTION) {
    // Keep a minimal selection inside the file.
    end = Math.min(duration, start + MIN_SELECTION);
    start = Math.max(0, end - MIN_SELECTION);
  }
  return { start, end };
}

function applyEdge(tr: Trim, edge: Edge, f: number, duration: number): Trim {
  if (edge === "in") return { start: clamp(f, 0, Math.max(0, tr.end - MIN_SELECTION)), end: tr.end };
  return { start: tr.start, end: clamp(f, Math.min(duration, tr.start + MIN_SELECTION), duration) };
}
