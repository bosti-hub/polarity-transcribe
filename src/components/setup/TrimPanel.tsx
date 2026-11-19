// The "choose start and end" block of the setup screen: loads waveform peaks, aligns two
// recordings, and wires the timeline model to an <audio> preview, a transport bar, keyboard
// shortcuts and editable in/out fields.

import { AlertTriangle, Link2, Maximize2, Pause, Play, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Callout, IconButton, Kbd, Spinner, Switch, TextInput, cx } from "@/components/ui";
import { Waveform, type WaveformRow } from "@/components/Waveform";
import { api, errorMessage, projectFileUrl } from "@/lib/api";
import { useT, type TFn } from "@/lib/i18n";
import { useApp } from "@/lib/store";
import { formatClock, parseClock } from "@/lib/transcript";
import type { Project, Source } from "@/lib/types";
import type { Edge, LaneSpec, TimelineModel, TrackSpec } from "./timelineModel";
import { mergePeaks } from "./waveDraw";


const toastError = (e: unknown) => void useApp.getState().toast(errorMessage(e), "error");

/** Identity of an imported file; changes when a slot is replaced. */
export function sourceKey(s: Source, slot: number): string {
  return `${slot}:${s.originalPath}:${s.fileName}:${s.duration}`;
}

interface Present {
  slot: number;
  source: Source;
}

function presentSources(project: Project): Present[] {
  const out: Present[] = [];
  project.sources.forEach((s, slot) => {
    if (s) out.push({ slot, source: s });
  });
  return out;
}

// ------------------------------------------------------------------ data hooks

/** Loads waveform peaks for every channel that is shown; keyed by file identity and side. */
function usePeaks(projectId: string, present: Present[]): Record<string, Uint8Array> {
  const [peaks, setPeaks] = useState<Record<string, Uint8Array>>({});
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);

  const wanted = present.flatMap(({ slot, source }) => {
    const base = sourceKey(source, slot);
    const list = [{ key: `${base}:L`, slot, right: false }];
    if (source.channels === 2) list.push({ key: `${base}:R`, slot, right: true });
    return list;
  });
  const wantedKey = wanted.map((w) => w.key).join("|");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    for (const w of wanted) {
      if (requested.current.has(w.key)) continue;
      requested.current.add(w.key);
      api
        .readPeaks(projectId, w.slot, w.right)
        .then((p) => {
          if (mounted.current) setPeaks((s) => ({ ...s, [w.key]: p }));
        })
        .catch((e) => {
          requested.current.delete(w.key);
          if (mounted.current) toastError(e);
        });
    }
    // `wanted` is fully described by `wantedKey`.
  }, [projectId, wantedKey]);

  return peaks;
}

type SyncState = { key: string; status: "running" } | { key: string; status: "done"; offset: number | null };

/** Runs quickSync once both recordings are present (and again when one is replaced). */
function useQuickSync(projectId: string, syncKey: string, onResult: (offset: number | null) => void): SyncState | null {
  const [sync, setSync] = useState<SyncState | null>(null);
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  });
  useEffect(() => {
    if (!syncKey) return;
    let alive = true;
    setSync({ key: syncKey, status: "running" });
    api
      .quickSync(projectId)
      .then((offset) => {
        if (!alive) return;
        setSync({ key: syncKey, status: "done", offset });
        onResultRef.current(offset);
      })
      .catch((e) => {
        if (!alive) return;
        setSync({ key: syncKey, status: "done", offset: null });
        onResultRef.current(null);
        toastError(e);
      });
    return () => {
      alive = false;
    };
  }, [projectId, syncKey]);
  return sync && sync.key === syncKey ? sync : null;
}

/** Re-renders when the model's active track changes. */
function useModelActive(model: TimelineModel): number {
  const [active, setActive] = useState(model.active);
  useEffect(() => {
    setActive(model.active);
    return model.subscribe((e) => {
      if (e === "active" || e === "tracks") setActive(model.active);
    });
  }, [model]);
  return active;
}

/** Writes text derived from the model straight into a DOM node, without re-rendering. */
function useModelText(model: TimelineModel, compute: () => string) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const computeRef = useRef(compute);
  useEffect(() => {
    computeRef.current = compute;
    if (ref.current) ref.current.textContent = compute();
  });
  useEffect(() => {
    return model.subscribe(() => {
      if (ref.current) ref.current.textContent = computeRef.current();
    });
  }, [model]);
  return ref;
}

// ------------------------------------------------------------------ panel

export function TrimPanel({ project, model }: { project: Project; model: TimelineModel }) {
  const t = useT();
  const present = useMemo(() => presentSources(project), [project]);
  const peaks = usePeaks(project.id, present);

  const dual = project.layout === "dual_file" && present.length === 2;
  const splitStereo = project.layout === "split_stereo" && present.length === 1 && present[0].source.channels === 2;

  // ---- alignment & linking
  const [linked, setLinked] = useState(true);
  const syncKey = dual ? present.map((p) => sourceKey(p.source, p.slot)).join("|") : "";
  const sync = useQuickSync(project.id, syncKey, (offset) => setLinked(offset !== null));
  const offset = sync?.status === "done" ? sync.offset : null;
  const canLink = dual && offset !== null;

  // ---- tracks for the model
  const merged = useRef(new Map<string, Uint8Array>());
  const tracks = useMemo<TrackSpec[]>(() => {
    const lane = (p: Present): LaneSpec => {
      const base = sourceKey(p.source, p.slot);
      const left = peaks[`${base}:L`] ?? null;
      let data = left;
      if (p.source.channels === 2) {
        const right = peaks[`${base}:R`];
        if (left && right) {
          data = merged.current.get(base) ?? mergePeaks(left, right);
          merged.current.set(base, data);
        }
      }
      return { peaks: data, color: p.slot === 0 ? "--sp1" : "--sp2" };
    };
    if (splitStereo) {
      const p = present[0];
      const base = sourceKey(p.source, p.slot);
      return [
        {
          key: base,
          slot: p.slot,
          duration: p.source.duration,
          offset: 0,
          lanes: [
            { peaks: peaks[`${base}:L`] ?? null, color: "--sp1", label: "L" },
            { peaks: peaks[`${base}:R`] ?? null, color: "--sp2", label: "R" },
          ],
        },
      ];
    }
    return present.map((p) => ({
      key: sourceKey(p.source, p.slot),
      slot: p.slot,
      duration: p.source.duration,
      offset: dual && offset !== null && p.slot === 1 ? offset : 0,
      lanes: [lane(p)],
    }));
  }, [present, peaks, splitStereo, dual, offset]);

  useEffect(() => {
    model.setTracks(
      tracks,
      tracks.map((tr) => {
        const s = project.sources[tr.slot];
        return s ? { start: s.trimStart, end: s.trimEnd } : { start: 0, end: tr.duration };
      }),
    );
    // Trims come from the project only for new files; the model keeps its own afterwards.
  }, [model, tracks]);

  useEffect(() => {
    model.setLinked(canLink && linked);
  }, [model, canLink, linked]);

  const [muted, setMuted] = useState<boolean[]>([]);
  const rows: WaveformRow[] = tracks.map((tr, i) => {
    const s = project.sources[tr.slot];
    return {
      label: t("setup.track", { n: tr.slot + 1 }),
      detail: s?.fileName,
      color: splitStereo ? "--sp1" : tr.slot === 0 ? "--sp1" : "--sp2",
      lanes: tr.lanes.length,
      // With two recordings both play together; each can be muted.
      muted: tracks.length > 1 ? !!muted[i] : undefined,
      onMute: tracks.length > 1 ? () => setMuted((m) => tracks.map((_, k) => (k === i ? !m[k] : !!m[k]))) : undefined,
    };
  });

  // ---- audio preview: one element per recording, played together and kept aligned on the
  // timeline. The active recording is the clock (and where I/O apply); muted ones stay silent.
  const active = useModelActive(model);
  const cacheKeys = useRef(new Map<string, number>());
  const urls = tracks.map((tr) => {
    const source = project.sources[tr.slot];
    if (!source) return null;
    // Cache-bust once per imported file, not on every project save (that would reload the audio).
    const k = sourceKey(source, tr.slot);
    if (!cacheKeys.current.has(k)) cacheKeys.current.set(k, project.updatedAt);
    return projectFileUrl(project, `source${tr.slot + 1}.m4a`, cacheKeys.current.get(k));
  });
  const urlKey = urls.join("|");

  const audios = useRef<HTMLAudioElement[]>([]);
  const raf = useRef(0);
  const [playing, setPlaying] = useState(false);

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    audios.current.forEach((a) => a.pause());
    setPlaying(false);
  }, []);

  useEffect(() => {
    const list = urlKey.split("|").map((url) => {
      const a = new Audio();
      a.preload = "auto";
      if (url && url !== "null") a.src = url;
      return a;
    });
    audios.current = list;
    stop();
    return () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      for (const a of list) {
        a.pause();
        a.removeAttribute("src");
        a.load();
      }
      audios.current = [];
    };
  }, [urlKey, stop]);

  useEffect(() => {
    audios.current.forEach((a, i) => (a.muted = !!muted[i]));
  }, [muted, urlKey]);

  /** Put every recording at the playhead (each on its own clock). */
  const alignAll = useCallback(() => {
    audios.current.forEach((a, i) => {
      const track = model.tracks[i];
      if (!track || !a.src) return;
      a.currentTime = Math.max(0, Math.min(track.duration, model.fileTime(i, model.playhead)));
    });
  }, [model]);

  // Playback drives the playhead; it stops at the active recording's out point.
  const tick = useCallback(() => {
    const i = model.active;
    const a = audios.current[i];
    const trim = model.trims[i];
    if (!a || !trim) return;
    if (a.currentTime >= trim.end || a.ended) {
      stop();
      model.setPlayhead(model.timelineTime(i, trim.end));
      return;
    }
    model.setPlayhead(model.timelineTime(i, a.currentTime), true);
    raf.current = requestAnimationFrame(tick);
  }, [model, stop]);

  const play = useCallback(() => {
    const i = model.active;
    const trim = model.trims[i];
    const track = model.tracks[i];
    const clock = audios.current[i];
    if (!clock || !trim || !track || !clock.src) return;
    const f = model.fileTime(i, model.playhead);
    if (f >= trim.end - 0.05 || f < 0 || f > track.duration) model.setPlayhead(model.timelineTime(i, trim.start), true);
    alignAll();
    const started = audios.current.filter((a) => a.src).map((a) => a.play());
    Promise.all(started)
      .then(() => {
        setPlaying(true);
        cancelAnimationFrame(raf.current);
        raf.current = requestAnimationFrame(tick);
      })
      .catch((e: unknown) => {
        // A pause() racing the start rejects with AbortError; that is not worth a toast.
        if (!(e instanceof DOMException && e.name === "AbortError")) toastError(e);
      });
  }, [model, tick, alignAll]);

  const toggle = useCallback(() => {
    if (playing) stop();
    else play();
  }, [play, stop, playing]);

  // User seeks while playing move every recording along.
  useEffect(() => {
    return model.subscribe((e) => {
      if (e === "seek" && playing) alignAll();
    });
  }, [model, alignAll, playing]);

  const setAtPlayhead = useCallback(
    (edge: Edge) => {
      const i = model.active;
      model.setEdge(i, edge, model.fileTime(i, model.playhead));
    },
    [model],
  );

  // ---- keyboard: Space, I, O, +/-; never while typing or inside a dialog / menu
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return;
      if (el?.closest?.('[role="dialog"],[role="menu"]')) return;
      const key = e.key.toLowerCase();
      if (key === " ") toggle();
      else if (key === "i") setAtPlayhead("in");
      else if (key === "o") setAtPlayhead("out");
      else if (key === "+" || key === "=") model.zoomBy(0.5);
      else if (key === "-") model.zoomBy(2);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [model, toggle, setAtPlayhead]);

  // ---- readouts (written to the DOM directly so playback does not re-render)
  const clockRef = useModelText(model, () => formatClock(Math.max(0, model.fileTime(model.active, model.playhead)), true));
  const selectedRef = useModelText(model, () => {
    const tr = model.trims[model.active];
    return t("setup.selected", { dur: formatClock(tr ? tr.end - tr.start : 0, true) });
  });

  const activeDuration = tracks[active]?.duration ?? 0;

  if (tracks.length === 0) return null;

  return (
    <div className="flex flex-col gap-4">
      {dual && <AlignmentRow t={t} sync={sync} linked={linked} onLinked={setLinked} />}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? t("setup.pause") : t("setup.play")}
          title={playing ? t("setup.pause") : t("setup.play")}
          className="flex size-10 items-center justify-center rounded-full bg-accent text-accent-fg shadow-card transition-colors hover:bg-accent-hover"
        >
          {playing ? <Pause className="size-[18px]" fill="currentColor" /> : <Play className="ml-0.5 size-[18px]" fill="currentColor" />}
        </button>
        <div className="flex items-baseline gap-1.5 px-2 font-mono text-[13px]">
          <span ref={clockRef} className="tabular text-fg" />
          <span className="tabular text-muted">/ {formatClock(activeDuration)}</span>
        </div>
        <div className="mx-1 h-6 w-px bg-line" />
        <Button size="sm" variant="ghost" onClick={() => setAtPlayhead("in")}>
          {t("setup.setIn")} <Kbd>I</Kbd>
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAtPlayhead("out")}>
          {t("setup.setOut")} <Kbd>O</Kbd>
        </Button>
        <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => model.reset()}>
          {t("setup.resetTrim")}
        </Button>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton label={t("setup.zoomOut")} shortcut="-" size="sm" onClick={() => model.zoomBy(2)}>
            <ZoomOut className="size-4" />
          </IconButton>
          <IconButton label={t("setup.zoomIn")} shortcut="+" size="sm" onClick={() => model.zoomBy(0.5)}>
            <ZoomIn className="size-4" />
          </IconButton>
          <IconButton label={t("setup.zoomFit")} size="sm" onClick={() => model.fit()}>
            <Maximize2 className="size-4" />
          </IconButton>
        </div>
      </div>

      <Waveform model={model} rows={rows} selectable={dual} activeHint={t("setup.play")} muteLabels={{ mute: t("setup.mute"), unmute: t("setup.unmute") }} />

      <div className="flex flex-wrap items-end gap-4 border-t border-line pt-4">
        <TimeField model={model} edge="in" label={t("setup.inPoint")} />
        <TimeField model={model} edge="out" label={t("setup.outPoint")} />
        <span ref={selectedRef} className="tabular pb-2 text-[13px] text-fg-2" />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function AlignmentRow({ t, sync, linked, onLinked }: { t: TFn; sync: SyncState | null; linked: boolean; onLinked: (v: boolean) => void }) {
  if (!sync || sync.status === "running") {
    return (
      <div className="flex items-center gap-2 text-[13px] text-fg-2">
        <Spinner />
        {t("setup.aligning")}
      </div>
    );
  }
  if (sync.offset === null) {
    return (
      <Callout tone="warn" icon={<AlertTriangle />}>
        {t("setup.alignFailed")}
      </Callout>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface-2 px-3.5 py-2.5">
      <Badge tone="ok">{t("setup.aligned", { offset: `${sync.offset.toFixed(3)} s` })}</Badge>
      <label className="ml-auto flex cursor-pointer items-center gap-2.5">
        <span className="flex flex-col text-right">
          <span className={cx("flex items-center justify-end gap-1.5 text-[13px] font-medium", linked ? "text-fg" : "text-fg-2")}>
            <Link2 className="size-3.5" />
            {t("setup.linkTracks")}
          </span>
          <span className="max-w-md text-xs text-muted">{t("setup.linkTracksHint")}</span>
        </span>
        <Switch checked={linked} onChange={onLinked} label={t("setup.linkTracks")} />
      </label>
    </div>
  );
}

/** An editable in/out time. Uncontrolled: the model writes into it unless it has focus. */
function TimeField({ model, edge, label }: { model: TimelineModel; edge: Edge; label: string }) {
  const ref = useRef<HTMLInputElement | null>(null);

  const current = useCallback(() => {
    const tr = model.trims[model.active];
    return tr ? (edge === "in" ? tr.start : tr.end) : 0;
  }, [model, edge]);

  const refresh = useCallback(() => {
    const el = ref.current;
    if (el && document.activeElement !== el) el.value = formatClock(current(), true);
  }, [current]);

  useEffect(() => {
    refresh();
    return model.subscribe((e) => {
      if (e === "trim" || e === "tracks" || e === "active") refresh();
    });
  }, [model, refresh]);

  const commit = () => {
    const el = ref.current;
    if (!el) return;
    const v = parseClock(el.value);
    if (v !== null) {
      const dur = model.tracks[model.active]?.duration ?? 0;
      // setEdge clamps to the file and keeps in before out.
      model.setEdge(model.active, edge, Math.max(0, Math.min(dur, v)));
    }
    el.value = formatClock(current(), true);
  };

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-fg-2">{label}</span>
      <TextInput
        ref={ref}
        className="tabular w-32 font-mono text-[13px]"
        inputMode="decimal"
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            e.currentTarget.select();
          } else if (e.key === "Escape") {
            e.currentTarget.value = formatClock(current(), true);
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
